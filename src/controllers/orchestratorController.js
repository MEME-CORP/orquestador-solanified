const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');
const { AppError } = require('../middleware/errorHandler');
const ApiResponseValidator = require('../utils/apiResponseValidator');

// Services
const walletService = require('../services/walletService');
const solService = require('../services/solService');
const pumpService = require('../services/pumpService');
const uploadService = require('../services/uploadService');
const notificationService = require('../services/notificationService');

// Models
const userModel = require('../models/userModel');
const bundlerModel = require('../models/bundlerModel');
const walletModel = require('../models/walletModel');
const tokenModel = require('../models/tokenModel');

const getDistributorWallet = (user = {}) => ({
  publicKey: user?.distributor_public_key || user?.in_app_public_key || null,
  privateKey: user?.distributor_private_key || user?.in_app_private_key || null
});

const getDistributorBalanceSol = (user = {}) =>
  Number(user?.distributor_balance_sol ?? user?.balance_sol ?? 0);

class OrchestratorController {
  static sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  static getRandomDelay(minMs, maxMs) {
    return minMs + Math.floor(Math.random() * (maxMs - minMs + 1));
  }

  static async waitForChildBalanceConfirmation(publicKey, expectedBalance, options = {}) {
    const {
      requestId,
      maxAttempts = 5,
      baseDelayMs = 2000,
      tolerance = 0.00005
    } = options;

    let lastResult = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        lastResult = await walletService.getSolBalance(publicKey, {
          maxRetries: 1,
          logProgress: attempt === 1
        });

        if (lastResult.balanceSol >= expectedBalance - tolerance) {
          if (attempt > 1) {
            logger.info('Child wallet balance confirmed after retries', {
              publicKey,
              requestId,
              attempt,
              balance: lastResult.balanceSol,
              expectedBalance
            });
          }
          return lastResult;
        }
      } catch (error) {
        logger.warn('Child wallet balance poll failed', {
          publicKey,
          requestId,
          attempt,
          error: error.message
        });
      }

      if (attempt < maxAttempts) {
        const delay = baseDelayMs * attempt + Math.floor(Math.random() * 500);
        logger.info('Waiting for child balance confirmation retry', {
          publicKey,
          requestId,
          attempt,
          nextDelayMs: delay,
          expectedBalance
        });
        await OrchestratorController.sleep(delay);
      }
    }

    logger.warn('Child wallet balance confirmation timed out, using last known value', {
      publicKey,
      requestId,
      expectedBalance,
      lastKnownBalance: lastResult?.balanceSol
    });

    return lastResult;
  }

  /**
   * Create in-app wallet for user
   * POST /api/orchestrator/create-wallet-in-app
   */
  async createWalletInApp(req, res, next) {
    const startTime = Date.now();
    const requestId = uuidv4();
    let user_wallet_id;

    try {
      ({ user_wallet_id } = req.body);

      logger.info('🚀 [CREATE_WALLET_IN_APP] Request started', {
        requestId,
        user_wallet_id,
        timestamp: new Date().toISOString(),
        endpoint: 'POST /api/orchestrator/create-wallet-in-app',
        ip: req.ip,
        userAgent: req.get('User-Agent')
      });

      // Step 1: Validate input
      if (!user_wallet_id) {
        logger.error('❌ [CREATE_WALLET_IN_APP] Missing user_wallet_id', {
          requestId,
          body: req.body
        });
        throw new AppError('user_wallet_id is required', 400, 'MISSING_USER_WALLET_ID');
      }

      logger.info('✅ [CREATE_WALLET_IN_APP] Input validation passed', {
        requestId,
        user_wallet_id
      });

      // Step 2: Check if user already exists
      logger.info('🔍 [CREATE_WALLET_IN_APP] Checking if user already exists', {
        requestId,
        user_wallet_id
      });

      const existingUser = await userModel.getUserByWalletId(user_wallet_id);
      const existingDistributorKey = existingUser?.distributor_public_key;
      const existingDevKey = existingUser?.dev_public_key;

      if (existingUser) {
        logger.info('📋 [CREATE_WALLET_IN_APP] User found in database', {
          requestId,
          user_wallet_id,
          has_distributor_wallet: !!existingDistributorKey,
          has_dev_wallet: !!existingDevKey,
          distributor_public_key: existingDistributorKey ? 'exists' : 'none'
        });

        if (existingDistributorKey) {
          logger.warn('⚠️ [CREATE_WALLET_IN_APP] User already has a distributor wallet', {
            requestId,
            user_wallet_id,
            existing_public_key: existingDistributorKey
          });
          throw new AppError('User already has an in-app wallet', 409, 'USER_ALREADY_EXISTS');
        }
      } else {
        logger.info('👤 [CREATE_WALLET_IN_APP] New user - no existing record found', {
          requestId,
          user_wallet_id
        });
      }

      // Step 3: Create wallet via external blockchain API
      logger.info('🔗 [CREATE_WALLET_IN_APP] Calling blockchain API to create wallet', {
        requestId,
        user_wallet_id,
        api_endpoint: '/wallet/create',
        wallet_count: 1
      });

      const walletCreationStart = Date.now();
      const walletData = await walletService.createInAppWallet(1);
      const walletCreationTime = Date.now() - walletCreationStart;
      
      const distributorWallet = walletData[0]; // First wallet from array

      logger.info('✅ [CREATE_WALLET_IN_APP] Blockchain API call successful', {
        requestId,
        user_wallet_id,
        wallet_creation_time_ms: walletCreationTime,
        public_key_created: distributorWallet.publicKey,
        private_key_exists: !!distributorWallet.privateKey
      });

      // Step 4: Store user data in database
      logger.info('💾 [CREATE_WALLET_IN_APP] Storing user data in database', {
        requestId,
        user_wallet_id,
        distributor_public_key: distributorWallet.publicKey
      });

      const dbInsertStart = Date.now();
      await userModel.createUser(
        user_wallet_id,
        distributorWallet.privateKey,
        distributorWallet.publicKey
      );
      const dbInsertTime = Date.now() - dbInsertStart;

      logger.info('✅ [CREATE_WALLET_IN_APP] User data stored successfully', {
        requestId,
        user_wallet_id,
        distributor_public_key: distributorWallet.publicKey,
        db_insert_time_ms: dbInsertTime
      });

      // Step 5: Send success notification to frontend (optional - non-blocking)
      logger.info('📢 [CREATE_WALLET_IN_APP] Sending notification to frontend', {
        requestId,
        user_wallet_id,
        distributor_public_key: distributorWallet.publicKey,
        frontend_url: process.env.FRONTEND_URL || 'https://frontend-solanified.onrender.com'
      });

      const notificationStart = Date.now();
      try {
        await notificationService.sendWalletCreationNotification(
          user_wallet_id,
          distributorWallet.publicKey
        );
        const notificationTime = Date.now() - notificationStart;
        
        logger.info('✅ [CREATE_WALLET_IN_APP] Notification sent successfully', {
          requestId,
          user_wallet_id,
          notification_time_ms: notificationTime
        });
      } catch (notificationError) {
        const notificationTime = Date.now() - notificationStart;
        
        logger.warn('⚠️ [CREATE_WALLET_IN_APP] Notification failed but continuing', {
          requestId,
          user_wallet_id,
          notification_time_ms: notificationTime,
          error: notificationError.message,
          note: 'Frontend uses polling for wallet detection, notification not critical'
        });
      }
      
      const notificationTime = Date.now() - notificationStart;

      // Step 6: Prepare response
      const DEV_WALLET_CREATION_DELAY_MS = 2 * 60 * 1000;
      const totalTime = Date.now() - startTime;
      const devWalletStatus = existingDevKey ? 'ready' : 'pending';
      const response = {
        distributor_public_key: distributorWallet.publicKey,
        distributor_balance_sol: '0',
        distributor_balance: 0,
        // Maintain backward-compatible alias for existing clients expecting in_app_* fields
        in_app_public_key: distributorWallet.publicKey,
        balance_sol: '0',
        balance: 0,
        dev_public_key: existingDevKey || null,
        dev_wallet_status: devWalletStatus,
        dev_wallet_ready_in_seconds: existingDevKey ? 0 : DEV_WALLET_CREATION_DELAY_MS / 1000
      };

      logger.info('🎉 [CREATE_WALLET_IN_APP] Request completed successfully', {
        requestId,
        user_wallet_id,
        distributor_public_key: distributorWallet.publicKey,
        total_time_ms: totalTime,
        wallet_creation_time_ms: walletCreationTime,
        db_insert_time_ms: dbInsertTime,
        notification_time_ms: notificationTime,
        response_data: response
      });

      res.json(response);

      const scheduleDevWalletCreation = () => {
        if (existingDevKey) {
          logger.info('⏭️ [CREATE_WALLET_IN_APP] Dev wallet already exists - skipping delayed creation', {
            requestId,
            user_wallet_id
          });
          return;
        }

        setTimeout(async () => {
          try {
            logger.info('⏱️ [CREATE_WALLET_IN_APP] Delayed dev wallet creation started', {
              requestId,
              user_wallet_id,
              delay_ms: DEV_WALLET_CREATION_DELAY_MS
            });

            const latestUser = await userModel.getUserByWalletId(user_wallet_id);
            if (latestUser?.dev_public_key) {
              logger.info('ℹ️ [CREATE_WALLET_IN_APP] Dev wallet already present at execution time - no action needed', {
                requestId,
                user_wallet_id
              });
              return;
            }

            const devWalletData = await walletService.createInAppWallet(1);
            const devWallet = devWalletData[0];

            await userModel.updateDevWalletKeys(
              user_wallet_id,
              devWallet.privateKey,
              devWallet.publicKey
            );

            await userModel.updateDevBalances(user_wallet_id, 0, 0);

            logger.info('✅ [CREATE_WALLET_IN_APP] Dev wallet created after delay', {
              requestId,
              user_wallet_id,
              dev_public_key: devWallet.publicKey
            });
          } catch (devError) {
            logger.error('❌ [CREATE_WALLET_IN_APP] Failed to create dev wallet after delay', {
              requestId,
              user_wallet_id,
              error_message: devError.message,
              error_code: devError.code
            });
          }
        }, DEV_WALLET_CREATION_DELAY_MS);
      };

      scheduleDevWalletCreation();

    } catch (error) {
      const totalTime = Date.now() - startTime;
      
      logger.error('❌ [CREATE_WALLET_IN_APP] Request failed', {
        requestId,
        user_wallet_id: user_wallet_id || 'unknown',
        error_code: error.code || 'UNKNOWN_ERROR',
        error_message: error.message,
        error_stack: error.stack,
        total_time_ms: totalTime,
        timestamp: new Date().toISOString()
      });

      // Log additional context for specific error types
      if (error.code === 'USER_ALREADY_EXISTS') {
        logger.warn('⚠️ [CREATE_WALLET_IN_APP] Duplicate wallet creation attempt', {
          requestId,
          user_wallet_id,
          error_details: 'User attempted to create wallet when one already exists'
        });
      } else if (error.code === 'EXTERNAL_WALLET_API_ERROR') {
        logger.error('🔗 [CREATE_WALLET_IN_APP] Blockchain API failure', {
          requestId,
          user_wallet_id,
          error_details: 'Failed to create wallet via external blockchain API',
          api_url: process.env.EXTERNAL_API_BASE_URL || 'https://rawapisolana-render.onrender.com:10000'
        });
      } else if (error.code === 'USER_CREATION_FAILED') {
        logger.error('💾 [CREATE_WALLET_IN_APP] Database operation failure', {
          requestId,
          user_wallet_id,
          error_details: 'Failed to store user data in database'
        });
      }

      next(error);
    }
  }

  /**
   * Create bundler with mother wallets
   * POST /api/orchestrator/create-bundler
   */
  async createBundler(req, res, next) {
    try {
      const { user_wallet_id, bundler_balance, idempotency_key } = req.body;
      const requestId = idempotency_key || uuidv4();

      logger.info('Creating bundler', { user_wallet_id, bundler_balance, requestId });

      // Get user data
      const user = await userModel.getUserByWalletId(user_wallet_id);
      if (!user) {
        throw new AppError('User not found', 404, 'USER_NOT_FOUND');
      }

      if (!user.distributor_public_key || !user.distributor_private_key) {
        throw new AppError('User missing distributor wallet credentials', 400, 'MISSING_DISTRIBUTOR_WALLET');
      }

      // Get live SOL balance
      const balanceData = await walletService.getSolBalance(user.distributor_public_key);
      const currentBalance = balanceData.balanceSol;

      // Validate balance requirements
      const MIN_BALANCE = 0.1;
      const requiredAmount = bundler_balance; // total planned funding amount for this bundler
      
      if (currentBalance < MIN_BALANCE) {
        throw new AppError(
          `Insufficient balance. Minimum ${MIN_BALANCE} SOL required`,
          402,
          'INSUFFICIENT_BALANCE'
        );
      }

      if (currentBalance < requiredAmount + 0.01) { // Add buffer for fees
        throw new AppError(
          `Insufficient balance. Need ${requiredAmount} SOL plus fees`,
          402,
          'INSUFFICIENT_BALANCE'
        );
      }

      // Create bundler and reserve mother wallets
      // Convert SOL budget (bundler_balance) into a count of mother wallets based on conservative per-mother estimate
      const MAX_CHILD_AMOUNT = 0.3; // max of 0.2–0.3
      const EST_FEE_BUFFER = 0.002;  // estimated fee buffer
      const perMotherEstimate = MAX_CHILD_AMOUNT + EST_FEE_BUFFER; // 0.302 SOL (upper bound)
      const motherWalletCount = Math.max(1, Math.floor(bundler_balance / perMotherEstimate));

      logger.info('Calculated mother wallet count from SOL budget', {
        bundler_balance,
        perMotherEstimate,
        motherWalletCount
      });

      const bundlerData = await bundlerModel.createBundlerWithMotherWallets(
        user_wallet_id,
        motherWalletCount
      );

      // Fund mother wallets with per-mother child amount (0.2–0.3 SOL) plus a small fee buffer
      logger.info('Funding mother wallets (single-child model: childAmount + fee buffer)', { count: bundlerData.allocated_mother_wallets.length });
      
      const childAmountByMotherId = new Map();
      const FEE_BUFFER = 0.002; // small buffer to cover mother->child transfer fees

      const fundingTransfers = bundlerData.allocated_mother_wallets.map(wallet => {
        const childAmount = 0.2 + Math.random() * 0.1; // 0.2 - 0.3 SOL
        childAmountByMotherId.set(wallet.id, childAmount);
        return {
          fromPublicKey: user.distributor_public_key,
          toPublicKey: wallet.public_key,
          amountSol: childAmount + FEE_BUFFER,
          privateKey: user.distributor_private_key,
          commitment: 'confirmed'
        };
      });

      let fundingSuccessful = 0;
      let fundingFailed = 0;
      const fundingErrors = [];

      for (let i = 0; i < fundingTransfers.length; i++) {
        const transferPayload = fundingTransfers[i];

        if (i > 0) {
          const delayMs = OrchestratorController.getRandomDelay(60000, 120000);
          logger.info(`Temporization: waiting ${delayMs}ms before next mother wallet funding`, {
            requestId,
            motherWalletOrder: i + 1
          });
          await OrchestratorController.sleep(delayMs);
        }

        try {
          await solService.transfer(transferPayload, `${requestId}-funding-${i}`);
          fundingSuccessful += 1;
        } catch (error) {
          fundingFailed += 1;
          fundingErrors.push({ index: i, error: error.message, toPublicKey: transferPayload.toPublicKey });
          logger.error('Mother wallet funding transfer failed', {
            requestId,
            index: i,
            toPublicKey: transferPayload.toPublicKey,
            error: error.message
          });
        }
      }

      const fundingResults = {
        successful: fundingSuccessful,
        failed: fundingFailed,
        errors: fundingErrors
      };

      if (fundingResults.failed > 0) {
        logger.error('Some mother wallet funding failed', { 
          successful: fundingResults.successful,
          failed: fundingResults.failed
        });
        // Continue with partial success - reconciliation can handle this later
      }

      // Update user balance (with rate limiting)
      logger.info(`Rate limiting: waiting 300ms before user balance check`);
      await OrchestratorController.sleep(300);
      
      try {
        const newUserBalance = await walletService.getSolBalance(user.distributor_public_key);
        await userModel.updateDistributorBalances(
          user_wallet_id,
          newUserBalance.balanceSol,
          user.distributor_balance_spl
        );
      } catch (balanceError) {
        logger.error('Failed to update user balance after mother wallet funding', {
          userWalletId: user_wallet_id,
          error: balanceError.message
        });
      }

      // Update mother wallet balances (with rate limiting)
      for (let i = 0; i < bundlerData.allocated_mother_wallets.length; i++) {
        const wallet = bundlerData.allocated_mother_wallets[i];
        
        // Add delay between mother wallet balance checks
        if (i > 0) {
          logger.info(`Rate limiting: waiting 300ms before next mother wallet balance check`);
          await OrchestratorController.sleep(300);
        }
        
        try {
          const motherBalance = await walletService.getSolBalance(wallet.public_key);
          await walletModel.updateMotherWalletBalance(wallet.id, motherBalance.balanceSol);
        } catch (balanceError) {
          logger.error('Failed to update mother wallet balance after funding', {
            motherWalletId: wallet.id,
            publicKey: wallet.public_key,
            error: balanceError.message
          });
          // Continue with other wallets
        }
      }

      // Fan out to child wallets
      logger.info('Distributing to child wallets');
      // Global sequentialization: ensure only one child funding happens at a time across all mothers
      let isFirstChildTransfer = true;
      
      for (let motherIndex = 0; motherIndex < bundlerData.allocated_mother_wallets.length; motherIndex++) {
        const motherWallet = bundlerData.allocated_mother_wallets[motherIndex];
        try {
          const childWallets = await walletModel.getChildWalletsByMother(motherWallet.id);
          
          if (childWallets.length === 0) {
            logger.warn('No child wallets found for mother wallet', { motherWalletId: motherWallet.id });
            continue;
          }

          const initialChildBalances = new Map(
            childWallets.map(child => [child.public_key, parseFloat(child.balance_sol) || 0])
          );

          // Determine distribution per mother
          // If there is exactly one child wallet, use the precomputed per-mother child amount (0.2–0.3 SOL)
          let distributions;
          if (childWallets.length === 1) {
            const planned = childAmountByMotherId.get(motherWallet.id);
            const amount = planned !== undefined ? planned : (0.2 + Math.random() * 0.1);
            distributions = [amount];
          } else {
            // Fallback for multi-child scenarios (not expected now)
            distributions = OrchestratorController.generateRandomDistribution(childWallets.length, 0.99);
          }

          // Sequential transfers with randomized 1–2 minute delays to avoid simultaneous funding across any wallets
          for (let i = 0; i < childWallets.length; i++) {
            const child = childWallets[i];
            const amount = distributions[i];

            try {
              // Randomized delay between 1 and 2 minutes before this child transfer (skip before very first overall)
              if (!isFirstChildTransfer) {
                const delayMs = OrchestratorController.getRandomDelay(60000, 120000);
                logger.info(`Temporization: waiting ${delayMs}ms before next child transfer`, {
                  motherWalletId: motherWallet.id,
                  nextChildIndex: i
                });
                await OrchestratorController.sleep(delayMs);
              }
              isFirstChildTransfer = false;

              logger.info('Initiating child wallet funding', {
                motherWalletId: motherWallet.id,
                fromPublicKey: motherWallet.public_key,
                toPublicKey: child.public_key,
                amountSol: amount.toFixed(9),
                index: i,
                totalChildren: childWallets.length
              });

              await solService.transfer({
                fromPublicKey: motherWallet.public_key,
                toPublicKey: child.public_key,
                amountSol: amount,
                privateKey: motherWallet.private_key,
                commitment: 'confirmed'
              }, `${requestId}-child-${motherWallet.id}-${i}`);

              // Small delay before balance check to respect API rate limits
              if (i > 0) {
                logger.info(`Rate limiting: waiting 300ms before balance check`);
                await OrchestratorController.sleep(300);
              }

              // Update child wallet balance from blockchain
              try {
                const baseline = initialChildBalances.get(child.public_key) || 0;
                const expectedBalance = baseline + amount;
                const childBalance = await OrchestratorController.waitForChildBalanceConfirmation(
                  child.public_key,
                  expectedBalance,
                  { requestId }
                );

                const finalChildBalance = childBalance?.balanceSol ?? Math.max(expectedBalance - 0.00001, 0);

                await walletModel.updateChildWalletSolBalance(child.public_key, finalChildBalance);
              } catch (balanceError) {
                logger.error('Failed to update child wallet balance after transfer', {
                  publicKey: child.public_key,
                  error: balanceError.message
                });
              }

            } catch (transferError) {
              logger.error('Child wallet funding failed', {
                motherWalletId: motherWallet.id,
                toPublicKey: child.public_key,
                error: transferError.message
              });
              // Continue with next child even if one transfer fails
            }

            // Note: No additional post-transfer delay here; pre-transfer delay above ensures global spacing
          }

          // Update mother wallet balance after distributions (with rate limiting)
          logger.info(`Rate limiting: waiting 300ms before mother wallet balance check`);
          await OrchestratorController.sleep(300); // Additional delay for mother wallet
          
          try {
            const updatedMotherBalance = await walletService.getSolBalance(motherWallet.public_key);
            await walletModel.updateMotherWalletBalance(motherWallet.id, updatedMotherBalance.balanceSol);
          } catch (balanceError) {
            logger.error('Failed to update mother wallet balance after child distributions', {
              motherWalletId: motherWallet.id,
              publicKey: motherWallet.public_key,
              error: balanceError.message
            });
            // Continue with bundler creation even if mother wallet balance update fails
          }

          try {
            const persistedChildren = await walletModel.getChildWalletsByMother(motherWallet.id);
            const aggregatedChildSol = persistedChildren.reduce((sum, child) => sum + (parseFloat(child.balance_sol) || 0), 0);
            const aggregatedChildSpl = persistedChildren.reduce((sum, child) => sum + (parseFloat(child.balance_spl) || 0), 0);

            await bundlerModel.updateAssignedMotherChildBalances(
              bundlerData.bundler_id,
              motherWallet.id,
              Number(aggregatedChildSol.toFixed(9)),
              Number(aggregatedChildSpl.toFixed(9))
            );
          } catch (aggregationError) {
            logger.error('Failed to persist aggregated child balances for mother wallet', {
              bundlerId: bundlerData.bundler_id,
              motherWalletId: motherWallet.id,
              error: aggregationError.message
            });
          }

          if (motherIndex < bundlerData.allocated_mother_wallets.length - 1) {
            const delayMs = OrchestratorController.getRandomDelay(60000, 120000);
            logger.info(`Temporization: waiting ${delayMs}ms before next mother wallet distribution`, {
              requestId,
              currentMotherWalletId: motherWallet.id,
              nextMotherIndex: motherIndex + 1
            });
            await OrchestratorController.sleep(delayMs);
          }

        } catch (error) {
          logger.error('Error distributing to child wallets', {
            motherWalletId: motherWallet.id,
            error: error.message
          });
          // Continue with other mother wallets
        }
      }

      // Get final bundler state
      const finalBundler = await bundlerModel.getBundlerWithWallets(bundlerData.bundler_id);

      logger.info('Bundler created successfully', {
        bundler_id: bundlerData.bundler_id,
        mother_wallets_count: bundlerData.allocated_mother_wallets.length
      });

      res.json({
        bundler_id: bundlerData.bundler_id,
        allocated_mother_wallets: bundlerData.allocated_mother_wallets.map(w => ({
          id: w.id,
          public_key: w.public_key
        })),
        total_balance_sol: finalBundler.total_balance_sol,
        message: "Bundler created and funded."
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Create token and buy with bundler
   * POST /api/orchestrator/create-and-buy-token-pumpFun
   */
  async createAndBuyTokenPumpFun(req, res, next) {
    try {
      const {
        user_wallet_id,
        name,
        symbol,
        description,
        logo_base64,
        twitter,
        telegram,
        website,
        dev_buy_amount,
        slippage,
        priority_fee
      } = req.body;

      const requestId = uuidv4();

      logger.info('Creating and buying token', { requestId, user_wallet_id, symbol, dev_buy_amount });

      // Validate input parameters
      if (!name || !symbol || !description) {
        throw new AppError('Missing required token parameters: name, symbol, description', 400, 'MISSING_TOKEN_PARAMS');
      }

      if (!logo_base64) {
        throw new AppError('Logo image is required', 400, 'MISSING_LOGO');
      }

      const devBuyAmountNum = parseFloat(dev_buy_amount);
      if (isNaN(devBuyAmountNum) || devBuyAmountNum <= 0) {
        throw new AppError('dev_buy_amount must be a positive number', 400, 'INVALID_DEV_BUY_AMOUNT');
      }

      const slippageNum = parseFloat(slippage);
      if (isNaN(slippageNum) || slippageNum < 0 || slippageNum > 100) {
        throw new AppError('slippage must be a number between 0 and 100', 400, 'INVALID_SLIPPAGE');
      }

      // Get user and latest active bundler
      const user = await userModel.getUserByWalletId(user_wallet_id);
      if (!user) {
        throw new AppError('User not found', 404, 'USER_NOT_FOUND');
      }

      const distributorPublicKey = user.distributor_public_key;
      const distributorPrivateKey = user.distributor_private_key;
      const devPublicKey = user.dev_public_key;
      const devPrivateKey = user.dev_private_key;

      if (!distributorPublicKey || !distributorPrivateKey) {
        throw new AppError('User missing distributor wallet keys', 400, 'MISSING_DISTRIBUTOR_WALLET');
      }

      if (!devPublicKey || !devPrivateKey) {
        logger.warn('Dev wallet not ready for token creation', {
          requestId,
          user_wallet_id,
          has_dev_public_key: !!devPublicKey,
          has_dev_private_key: !!devPrivateKey
        });
        throw new AppError('Dev wallet not ready yet. Please retry after it has been provisioned.', 409, 'DEV_WALLET_NOT_READY');
      }

      const bundler = await bundlerModel.getLatestActiveBundler(user_wallet_id);
      if (!bundler) {
        throw new AppError('No active bundler found', 404, 'NO_ACTIVE_BUNDLER');
      }

      // Ensure Dev wallet has enough SOL for dev buy (including recommended buffer)
      const DEV_SOL_BUFFER = 0.3;
      const requiredDevSol = devBuyAmountNum + DEV_SOL_BUFFER;

      const devBalanceData = await walletService.getSolBalance(devPublicKey);
      let devAvailableSol = devBalanceData.balanceSol;

      logger.info('Checking Dev wallet balance before token creation', {
        requestId,
        user_wallet_id,
        devPublicKey,
        devAvailableSol,
        requiredDevSol,
        bufferSol: DEV_SOL_BUFFER
      });

      if (devAvailableSol + 1e-9 < requiredDevSol) {
        const distributorBalanceData = await walletService.getSolBalance(distributorPublicKey);
        const distributorAvailableSol = distributorBalanceData.balanceSol;
        const transferAmount = parseFloat((requiredDevSol - devAvailableSol).toFixed(9));

        logger.info('Prefunding Dev wallet from Distributor', {
          requestId,
          user_wallet_id,
          devPublicKey,
          distributorPublicKey,
          transferAmount,
          distributorAvailableSol
        });

        if (transferAmount <= 0) {
          logger.info('Dev wallet already satisfies SOL requirements after rounding', {
            requestId,
            user_wallet_id,
            devPublicKey,
            transferAmount
          });
        } else {
          if (distributorAvailableSol < transferAmount + 0.01) {
            throw new AppError('Distributor wallet lacks sufficient SOL to fund Dev wallet', 402, 'INSUFFICIENT_DISTRIBUTOR_FUNDS');
          }

          await solService.transfer({
            fromPublicKey: distributorPublicKey,
            toPublicKey: devPublicKey,
            amountSol: transferAmount,
            privateKey: distributorPrivateKey,
            commitment: 'confirmed'
          }, `${requestId}-dev-prefund`);

          // Refresh balances post transfer
          const [updatedDistributorBalance, updatedDevBalance] = await Promise.all([
            walletService.getSolBalance(distributorPublicKey),
            walletService.getSolBalance(devPublicKey)
          ]);

          devAvailableSol = updatedDevBalance.balanceSol;

          await userModel.updateDistributorBalances(
            user_wallet_id,
            updatedDistributorBalance.balanceSol,
            parseFloat(user.distributor_balance_spl || 0)
          );

          await userModel.updateDevBalances(
            user_wallet_id,
            updatedDevBalance.balanceSol,
            parseFloat(user.dev_balance_spl || 0)
          );

          logger.info('Dev wallet prefunding completed', {
            requestId,
            user_wallet_id,
            devPublicKey,
            devAvailableSol
          });
        }
      }

      // Upload logo to Pinata
      logger.info('Uploading token logo', {
        requestId,
        logoSize: logo_base64?.length || 0,
        hasDataUri: logo_base64?.startsWith('data:') || false
      });
      
      const imageUrl = await uploadService.processAndUploadLogo(logo_base64, `${symbol.toLowerCase()}-logo`);

      // Create token on Pump.fun
      logger.info('Creating token on Pump.fun', {
        requestId,
        creatorPublicKey: devPublicKey,
        name,
        symbol,
        description,
        imageUrl,
        twitter: twitter || '',
        telegram: telegram || '',
        website: website || '',
        devBuyAmount: parseFloat(dev_buy_amount),
        slippageBps: Math.round(slippage * 100),
        priorityFeeSol: parseFloat(priority_fee) || 0.000005
      });
      
      const tokenCreationData = {
        creatorPublicKey: devPublicKey,
        name,
        symbol,
        description,
        imageUrl,
        twitter: twitter || '',
        telegram: telegram || '',
        website: website || '',
        devBuyAmount: parseFloat(dev_buy_amount),
        slippageBps: Math.round(slippage * 100), // Convert percentage to basis points
        priorityFeeSol: parseFloat(priority_fee) || 0.000005,
        privateKey: devPrivateKey,
        commitment: 'confirmed'
      };

      const tokenResult = await pumpService.createToken(tokenCreationData);

      // Extract contract address from the result using validator
      const contractAddress = ApiResponseValidator.extractContractAddress(tokenResult);

      if (!contractAddress) {
        throw new AppError('Failed to get contract address from token creation response', 500, 'CONTRACT_ADDRESS_MISSING');
      }

      // Save token to database
      await tokenModel.createToken({
        name,
        symbol,
        description,
        imageUrl,
        twitter: twitter || null,
        telegram: telegram || null,
        website: website || null,
        devBuyAmount: parseFloat(dev_buy_amount),
        contractAddress,
        userWalletId: user_wallet_id
      });

      // Update bundler token name
      await bundlerModel.updateTokenName(bundler.id, symbol);

      // Extract and update user balances from token creation response
      const creationBalances = ApiResponseValidator.extractCreationBalances(tokenResult);
      
      logger.info('Extracted token creation balances', {
        solBalance: creationBalances.solBalance,
        splBalance: creationBalances.splBalance,
        mintAddress: creationBalances.mintAddress,
        signature: creationBalances.signature
      });

      // Update Dev wallet SOL balance from token creation result
      if (creationBalances.solBalance > 0 || creationBalances.splBalance > 0) {
        await userModel.updateDevBalances(
          user_wallet_id,
          creationBalances.solBalance,
          creationBalances.splBalance
        );
      }

      // Handle SPL balance update with blockchain API fallback for Dev wallet
      let finalSplBalance = creationBalances.splBalance;
      
      if (creationBalances.splBalance === 0) {
        logger.warn('SPL balance is 0 after token creation - fetching from blockchain API', {
          requestId,
          user_wallet_id,
          contractAddress,
          devPublicKey,
          signature: creationBalances.signature,
          strategy: 'blockchain_api_fallback'
        });

        try {
          // Add a small delay to allow blockchain settlement
          await new Promise(resolve => setTimeout(resolve, 2000)); // 2 second delay
          
          const actualSplBalance = await walletService.getSplBalance(
            contractAddress,
            devPublicKey,
            { maxRetries: 3, logProgress: true }
          );

          finalSplBalance = actualSplBalance.uiAmount || actualSplBalance.balance || 0;

          logger.info('Successfully retrieved SPL balance from blockchain API after token creation', {
            requestId,
            user_wallet_id,
            contractAddress,
            devPublicKey,
            apiResponseBalance: creationBalances.splBalance,
            blockchainActualBalance: finalSplBalance,
            signature: creationBalances.signature
          });

        } catch (fallbackError) {
          logger.error('Failed to retrieve SPL balance from blockchain API after token creation', {
            requestId,
            user_wallet_id,
            contractAddress,
            devPublicKey,
            error: fallbackError.message,
            signature: creationBalances.signature,
            fallback_strategy: 'estimate_from_dev_buy'
          });

          // If blockchain API fails, estimate SPL balance based on dev buy amount
          // This is a reasonable estimate since we know tokens were purchased
          if (dev_buy_amount && parseFloat(dev_buy_amount) > 0) {
            // Estimate SPL tokens received based on typical pump.fun mechanics
            // This is approximate but better than leaving it at 0 when we know tokens were bought
            const devBuyAmountSol = parseFloat(dev_buy_amount);
            const estimatedSplTokens = devBuyAmountSol * 1000000; // Rough estimate: 1 SOL = ~1M tokens (varies by bonding curve)
            
            finalSplBalance = estimatedSplTokens;
            
            logger.warn('Estimated SPL balance based on dev buy amount', {
              user_wallet_id,
              contractAddress,
              devBuyAmountSol,
              estimatedSplTokens,
              signature: creationBalances.signature,
              note: 'This is an estimate - actual balance may vary'
            });
          } else {
            // Keep SPL balance as 0 if we can't estimate
            finalSplBalance = 0;
          }
        }
      }

      // Update Dev SPL balance (either from API response or blockchain API)
      if (finalSplBalance > 0) {
        await userModel.updateDevBalances(
          user_wallet_id,
          creationBalances.solBalance,
          finalSplBalance
        );
        
        logger.info('Dev SPL balance updated after token creation', {
          requestId,
          user_wallet_id,
          splBalance: finalSplBalance,
          balanceSource: creationBalances.splBalance > 0 ? 'api_response' : 'blockchain_api_fallback'
        });
      } else {
        logger.warn('Dev SPL balance remains 0 after token creation and fallback attempts', {
          requestId,
          user_wallet_id,
          contractAddress,
          signature: creationBalances.signature,
          note: 'Balance may need manual verification or delayed update'
        });
      }

      // Get child wallets for buying
      const bundlerWithWallets = await bundlerModel.getBundlerWithWallets(bundler.id);
      const childWallets = [];
      
      for (const motherWallet of bundlerWithWallets.mother_wallets) {
        childWallets.push(...motherWallet.child_wallets);
      }

      // Filter child wallets with sufficient SOL balance for buying (using database values)
      const MIN_BUY_AMOUNT = 0.001;
      const BUY_TRANSACTION_FEE = 0.003; // SOL needed for buy transaction + priority fee
      const SELL_TRANSACTION_FEE = 0.003; // SOL that must remain for future sell transactions
      const SAFETY_BUFFER = 0.002; // Additional safety buffer for balance discrepancies
      const TOTAL_REQUIRED_RESERVE = BUY_TRANSACTION_FEE + SELL_TRANSACTION_FEE + SAFETY_BUFFER;
      const buyableWallets = [];

        logger.info('Checking child wallet balances with buy/sell fee considerations', {
          totalChildWallets: childWallets.length,
          minBuyAmount: MIN_BUY_AMOUNT,
          buyTransactionFee: BUY_TRANSACTION_FEE,
          sellTransactionFee: SELL_TRANSACTION_FEE,
          safetyBuffer: SAFETY_BUFFER,
          totalRequiredReserve: TOTAL_REQUIRED_RESERVE
        });

      for (const wallet of childWallets) {
        const dbBalance = parseFloat(wallet.balance_sol);
        // Calculate available amount considering buy fees, sell fees, and safety buffer
        const availableForBuy = Math.max(dbBalance - TOTAL_REQUIRED_RESERVE, 0);
        
        logger.info('Child wallet balance check - buy/sell fee aware', {
          publicKey: wallet.public_key,
          dbBalance,
          buyTransactionFee: BUY_TRANSACTION_FEE,
          sellTransactionFee: SELL_TRANSACTION_FEE,
          safetyBuffer: SAFETY_BUFFER,
          totalReserved: TOTAL_REQUIRED_RESERVE,
          availableForBuy,
          meetsMinimum: availableForBuy >= MIN_BUY_AMOUNT
        });

        if (availableForBuy >= MIN_BUY_AMOUNT) {
          buyableWallets.push({
            ...wallet,
            // Apply conservative reduction and cap at 0.25 SOL (reduced due to sell fee consideration)
            availableForBuy: Math.min(availableForBuy * 0.85, 0.25)
          });
        }
      }

      if (buyableWallets.length === 0) {
        logger.warn('No child wallets have sufficient balance for buying (including sell fees)', {
          totalWallets: childWallets.length,
          minRequired: MIN_BUY_AMOUNT + TOTAL_REQUIRED_RESERVE,
          breakdown: {
            minBuyAmount: MIN_BUY_AMOUNT,
            buyTransactionFee: BUY_TRANSACTION_FEE,
            sellTransactionFee: SELL_TRANSACTION_FEE,
            safetyBuffer: SAFETY_BUFFER,
            total: MIN_BUY_AMOUNT + TOTAL_REQUIRED_RESERVE
          },
          walletBalances: childWallets.map(w => ({
            publicKey: w.public_key,
            dbBalance: parseFloat(w.balance_sol),
            shortfall: Math.max(0, (MIN_BUY_AMOUNT + TOTAL_REQUIRED_RESERVE) - parseFloat(w.balance_sol))
          }))
        });
      } else {
        // Execute buy operations with sell-fee-aware calculations
        logger.info('Executing buy operations with sell-fee considerations', { 
          walletCount: buyableWallets.length,
          totalAvailable: buyableWallets.reduce((sum, w) => sum + w.availableForBuy, 0).toFixed(6),
          sellFeesReserved: (SELL_TRANSACTION_FEE * buyableWallets.length).toFixed(6)
        });
        
        const buyOperations = buyableWallets.map(wallet => ({
          buyerPublicKey: wallet.public_key,
          mintAddress: contractAddress,
          solAmount: wallet.availableForBuy, // Use calculated available amount from database
          slippageBps: Math.round(slippage * 100),
          priorityFeeSol: priority_fee || 0.000005,
          privateKey: wallet.private_key,
          commitment: 'confirmed'
        }));

        // Log the prepared operations for debugging
        logger.info('Buy operations prepared with sell-fee awareness', {
          operations: buyOperations.map((op, i) => ({
            index: i,
            wallet: op.buyerPublicKey,
            dbBalance: parseFloat(buyableWallets[i].balance_sol),
            solAmountToBuy: op.solAmount,
            reservedForBuyFee: BUY_TRANSACTION_FEE,
            reservedForSellFee: SELL_TRANSACTION_FEE,
            safetyBuffer: SAFETY_BUFFER,
            totalReserved: TOTAL_REQUIRED_RESERVE,
            safetyReduction: '85% of available',
            maxCap: '0.25 SOL',
            priorityFee: op.priorityFeeSol,
            remainingAfterBuy: (parseFloat(buyableWallets[i].balance_sol) - op.solAmount).toFixed(6)
          }))
        });

        const buyResults = await pumpService.batchBuy(buyOperations, `token-buy-${bundler.id}`);

         // Update child wallet balances from buy results and handle insufficient balance errors
         let successfulBuys = 0;
         const balanceAdjustments = [];
         
         logger.info('Processing buy results and updating balances', {
           totalResults: buyResults.results.length,
           successfulTransactions: buyResults.successful
         });
         
         for (let i = 0; i < buyResults.results.length; i++) {
          const result = buyResults.results[i];
          const wallet = buyableWallets[i];
          
           if (result.success && result.data) {
             // Log the complete API response structure for debugging
             logger.info('Complete buy API response for debugging', {
               walletPublicKey: wallet.public_key,
               fullResponse: {
                 signature: result.data?.signature,
                 confirmed: result.data?.confirmed,
                 postBalances: result.data?.postBalances,
                 hasPostBalances: !!result.data?.postBalances,
                 solData: result.data?.postBalances?.sol,
                 splData: result.data?.postBalances?.spl
               }
             });
             
             const balances = ApiResponseValidator.extractTradeBalances(result.data);
             
             logger.info('Processing buy result for child wallet', {
               walletPublicKey: wallet.public_key,
               solBalance: balances.solBalance,
               splBalance: balances.splBalance,
               mintAddress: balances.mintAddress,
               signature: result.data?.signature,
               extractionDebug: {
                 originalSplUiAmount: result.data?.postBalances?.spl?.uiAmount,
                 originalSplRawAmount: result.data?.postBalances?.spl?.rawAmount,
                 extractedSplBalance: balances.splBalance,
                 splDataExists: !!result.data?.postBalances?.spl
               }
             });
             
             if (balances.publicKey) {
               let finalSplBalance = balances.splBalance;
               let shouldUpdateSplBalance = true;
               
               // Enhanced fallback strategy for zero SPL balance on successful transactions
               if (balances.splBalance === 0 && result.data?.signature) {
                 logger.warn('Successful buy transaction but SPL balance is 0 - implementing recovery strategy', {
                   walletPublicKey: wallet.public_key,
                   signature: result.data.signature,
                   solAmountSpent: buyOperations[i]?.solAmount,
                   postBalancesSpl: result.data?.postBalances?.spl,
                   mintAddress: contractAddress,
                   strategy: 'multi_step_recovery'
                 });
                 
                 // Step 1: Try blockchain API fallback with improved timing
                 try {
                   // Add progressive delay to allow blockchain settlement and reduce API load
                   const delay = Math.min(1000 + (i * 500), 3000); // 1-3 seconds progressive delay
                   await new Promise(resolve => setTimeout(resolve, delay));
                   
                   const actualSplBalance = await walletService.getSplBalance(
                     contractAddress, 
                     wallet.public_key,
                     { maxRetries: 3, logProgress: true }
                   );
                   
                   finalSplBalance = actualSplBalance.uiAmount || actualSplBalance.balance || 0;
                   
                   logger.info('Successfully retrieved SPL balance from blockchain API', {
                     walletPublicKey: wallet.public_key,
                     apiResponseBalance: balances.splBalance,
                     blockchainActualBalance: finalSplBalance,
                     signature: result.data.signature,
                     mintAddress: contractAddress
                   });
                   
                 } catch (fallbackError) {
                   logger.error('Blockchain API fallback failed - implementing protective strategy', {
                     walletPublicKey: wallet.public_key,
                     mintAddress: contractAddress,
                     signature: result.data.signature,
                     error: fallbackError.message,
                     solAmountSpent: buyOperations[i]?.solAmount,
                     strategy: 'preserve_existing_balance'
                   });
                   
                   // Step 2: If API fails, preserve existing balance and flag for later verification
                   const currentSplBalance = parseFloat(wallet.balance_spl) || 0;
                   
                   // Estimate SPL balance based on SOL spent if we have no existing balance
                   if (currentSplBalance === 0 && buyOperations[i]?.solAmount > 0) {
                     // Store transaction info for later verification instead of guessing balance
                     logger.warn('Transaction successful but unable to verify SPL balance - flagging for verification', {
                       walletPublicKey: wallet.public_key,
                       signature: result.data.signature,
                       solAmountSpent: buyOperations[i]?.solAmount,
                       mintAddress: contractAddress,
                       note: 'Balance verification needed - transaction confirmed but API unavailable'
                     });
                     
                     // Don't update SPL balance - preserve zero until we can verify
                     shouldUpdateSplBalance = false;
                   } else if (currentSplBalance > 0) {
                     finalSplBalance = currentSplBalance;
                     logger.info('Preserving existing SPL balance to prevent data corruption', {
                       requestId,
                       walletPublicKey: wallet.public_key,
                       preservedBalance: finalSplBalance,
                       signature: result.data.signature
                     });
                   } else {
                     // Don't update SPL balance at all - we know tokens were purchased
                     shouldUpdateSplBalance = false;
                     logger.warn('Skipping SPL balance update to prevent zero corruption', {
                       walletPublicKey: wallet.public_key,
                       signature: result.data.signature,
                       solAmountSpent: buyOperations[i]?.solAmount,
                       note: 'Manual verification may be needed'
                     });
                   }
                 }
               }
               
                // Always update both SOL and SPL balances - critical fix for buy operations
                await walletModel.updateChildWalletBalances(
                  wallet.public_key,
                  balances.solBalance,
                  finalSplBalance
                );
                
                logger.info('Child wallet balances updated after buy', {
                  requestId,
                  walletPublicKey: wallet.public_key,
                  solBalance: balances.solBalance,
                  splBalance: finalSplBalance,
                  signature: result.data?.signature,
                  splBalanceSource: shouldUpdateSplBalance ? 'api_or_fallback' : 'calculated_or_preserved',
                  balanceUpdateMethod: 'both_sol_and_spl'
                });
               
               successfulBuys++;
             }
           } else {
            // Check if it's an insufficient balance error with balance info
            if (result.error?.includes('Insufficient balance') || result.error?.includes('INSUFFICIENT_BALANCE')) {
              // Try to extract actual balance from error and update database
              const actualBalance = this.extractActualBalanceFromError(result.error);
              if (actualBalance !== null && actualBalance < parseFloat(wallet.balance_sol)) {
                logger.warn('Database balance mismatch detected, scheduling adjustment', {
                  walletPublicKey: wallet.public_key,
                  databaseBalance: parseFloat(wallet.balance_sol),
                  actualBalance: actualBalance,
                  difference: parseFloat(wallet.balance_sol) - actualBalance
                });
                
                balanceAdjustments.push({
                  publicKey: wallet.public_key,
                  newBalance: actualBalance
                });
              }
            }
            
            logger.error('Buy operation failed for child wallet', {
              requestId,
              walletPublicKey: wallet.public_key,
              error: result.error,
              databaseBalance: parseFloat(wallet.balance_sol)
            });
          }
        }
        
        // Apply balance adjustments to correct database mismatches
        for (const adjustment of balanceAdjustments) {
          try {
            await walletModel.updateChildWalletSolBalance(
              adjustment.publicKey, 
              adjustment.newBalance
            );
            
            logger.info('Updated child wallet balance based on blockchain feedback', {
              walletPublicKey: adjustment.publicKey,
              newBalance: adjustment.newBalance
            });
          } catch (error) {
            logger.error('Failed to update wallet balance', {
              walletPublicKey: adjustment.publicKey,
              error: error.message
            });
          }
        }
        
         logger.info('Batch buy operations summary', {
           totalWallets: buyableWallets.length,
           successfulBuys,
           failedBuys: buyableWallets.length - successfulBuys
         });

         // Post-processing: Summary of SPL balance recovery operations and delayed verification setup
         let fallbackCallsUsed = 0;
         let skippedSplUpdates = 0;
         const walletsNeedingVerification = [];
         
         for (let i = 0; i < buyResults.results.length; i++) {
           const result = buyResults.results[i];
           const wallet = buyableWallets[i];
           
           if (result.success && result.data?.signature) {
             const balances = ApiResponseValidator.extractTradeBalances(result.data);
             if (balances.splBalance === 0) {
               fallbackCallsUsed++;
               
               // Track wallets that may need manual verification
               walletsNeedingVerification.push({
                 publicKey: wallet.public_key,
                 signature: result.data.signature,
                 solAmountSpent: buyOperations[i]?.solAmount,
                 mintAddress: contractAddress,
                 timestamp: new Date().toISOString()
               });
             }
           }
         }

         // Log comprehensive summary
         if (fallbackCallsUsed > 0) {
           logger.info('SPL balance recovery operations summary', {
             totalFallbackCalls: fallbackCallsUsed,
             walletsNeedingVerification: walletsNeedingVerification.length,
             verificationDetails: walletsNeedingVerification,
             note: 'Some wallets may need delayed verification due to API issues'
           });
           
           // Schedule delayed verification (optional - could be implemented as a separate endpoint)
           if (walletsNeedingVerification.length > 0) {
             logger.warn('Consider implementing delayed SPL balance verification', {
               walletsToVerify: walletsNeedingVerification.length,
               suggestion: 'Create a separate verification endpoint to check these wallets after blockchain settlement',
               walletsDetails: walletsNeedingVerification.map(w => ({
                 wallet: w.publicKey,
                 signature: w.signature,
                 solSpent: w.solAmountSpent
               }))
             });
           }
         }

         logger.info('Buy operations completed', {
           requestId,
           successful: buyResults.successful,
           failed: buyResults.failed,
           fallbackCallsUsed: fallbackCallsUsed
         });
      }

      // Get final bundler state
      const finalBundler = await bundlerModel.getLatestActiveBundler(user_wallet_id);

      // FINAL STEP: Verify user SPL balance at the end of the whole flow
      // By now, the blockchain should have had enough time to settle all transactions
      logger.info('🔍 [FINAL_SPL_VERIFICATION] Verifying Dev SPL balance at end of flow', {
        requestId,
        user_wallet_id,
        contractAddress,
        devPublicKey,
        currentDevSplBalance: user.dev_balance_spl,
        strategy: 'end_of_flow_verification'
      });

      try {
        // Add extra delay to ensure blockchain settlement
        await new Promise(resolve => setTimeout(resolve, 3000)); // 3 second delay
        
        const finalDevSplBalance = await walletService.getSplBalance(
          contractAddress,
          devPublicKey,
          { maxRetries: 5, logProgress: true } // More retries for final verification
        );

        const verifiedDevBalance = finalDevSplBalance.uiAmount || finalDevSplBalance.balance || 0;

        if (verifiedDevBalance > 0) {
          // Update Dev SPL balance with the real blockchain value
          await userModel.updateDevBalances(
            user_wallet_id,
            devAvailableSol,
            verifiedDevBalance
          );

          logger.info('✅ [FINAL_SPL_VERIFICATION] Dev SPL balance updated with real blockchain value', {
            requestId,
            user_wallet_id,
            contractAddress,
            previousBalance: finalSplBalance,
            verifiedBalance: verifiedDevBalance,
            balanceSource: 'end_of_flow_blockchain_api',
            improvement: verifiedDevBalance > finalSplBalance ? 'significant_improvement' : 'minor_adjustment'
          });

          // Update the response to reflect the real balance
          finalSplBalance = verifiedDevBalance;
        } else {
          logger.warn('⚠️ [FINAL_SPL_VERIFICATION] Blockchain API still returns 0 - keeping estimated balance', {
            requestId,
            user_wallet_id,
            contractAddress,
            estimatedBalance: finalSplBalance,
            note: 'User may need to wait longer or check manually'
          });
        }

      } catch (finalVerificationError) {
        logger.error('❌ [FINAL_SPL_VERIFICATION] Final verification failed - keeping estimated balance', {
          requestId,
          user_wallet_id,
          contractAddress,
          error: finalVerificationError.message,
          estimatedBalance: finalSplBalance,
          note: 'This is acceptable - child wallets were updated successfully'
        });
      }

      logger.info('Token creation and buying completed', {
        requestId,
        symbol,
        contractAddress,
        bundler_id: bundler.id,
        final_user_spl_balance: finalSplBalance
      });

      res.json({
        contract_address: contractAddress,
        token_name: symbol,
        bundler_id: bundler.id,
        total_balance_spl: finalBundler.total_balance_spl,
        user_spl_balance: finalSplBalance
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Verify and update SPL balances for wallets after transaction settlement
   * POST /api/orchestrator/verify-spl-balances
   */
  async verifySplBalances(req, res, next) {
    try {
      const { mintAddress, walletPublicKeys } = req.body;

      if (!mintAddress || !Array.isArray(walletPublicKeys) || walletPublicKeys.length === 0) {
        throw new AppError('mintAddress and walletPublicKeys array are required', 400, 'MISSING_REQUIRED_FIELDS');
      }

      logger.info('Starting SPL balance verification', {
        mintAddress,
        walletCount: walletPublicKeys.length
      });

      const results = [];

      for (let i = 0; i < walletPublicKeys.length; i++) {
        const walletPublicKey = walletPublicKeys[i];
        
        try {
          // Add delay between requests to avoid overwhelming the API
          if (i > 0) {
            await new Promise(resolve => setTimeout(resolve, 1000));
          }

          const splBalance = await walletService.getSplBalance(
            mintAddress,
            walletPublicKey,
            { maxRetries: 3, logProgress: true }
          );

          const finalBalance = splBalance.uiAmount || splBalance.balance || 0;

          // Update the database
          await walletModel.updateChildWalletSplBalance(walletPublicKey, finalBalance);

          results.push({
            walletPublicKey,
            success: true,
            balance: finalBalance,
            updated: true
          });

          logger.info('SPL balance verified and updated', {
            walletPublicKey,
            balance: finalBalance,
            mintAddress
          });

        } catch (error) {
          results.push({
            walletPublicKey,
            success: false,
            error: error.message,
            updated: false
          });

          logger.error('Failed to verify SPL balance', {
            walletPublicKey,
            error: error.message,
            mintAddress
          });
        }
      }

      const successCount = results.filter(r => r.success).length;
      const failureCount = results.length - successCount;

      res.json({
        success: true,
        message: `SPL balance verification completed: ${successCount} successful, ${failureCount} failed`,
        data: {
          mintAddress,
          results,
          summary: {
            total: results.length,
            successful: successCount,
            failed: failureCount
          }
        }
      });

    } catch (error) {
      logger.error('Error verifying SPL balances:', { 
        error: error.message,
        body: req.body 
      });
      next(error);
    }
  }

  /**
   * Sell created token
   * POST /api/orchestrator/sell-created-token
   */
  async sellCreatedToken(req, res, next) {
    try {
      const { user_wallet_id, sell_percent } = req.body;
      const requestId = uuidv4();

      logger.info('Selling created token', { requestId, user_wallet_id, sell_percent });

      if (!sell_percent || sell_percent <= 0 || sell_percent > 100) {
        throw new AppError('sell_percent must be between 1 and 100', 400, 'INVALID_SELL_PERCENT');
      }

      const user = await userModel.getUserByWalletId(user_wallet_id);
      if (!user) {
        throw new AppError('User not found', 404, 'USER_NOT_FOUND');
      }

      const distributorPublicKey = user.distributor_public_key;

      if (!distributorPublicKey || !user.distributor_private_key) {
        throw new AppError('User missing distributor wallet credentials', 400, 'MISSING_DISTRIBUTOR_WALLET');
      }

      const bundler = await bundlerModel.getLatestActiveBundler(user_wallet_id);
      if (!bundler) {
        throw new AppError('No active bundler found', 404, 'NO_ACTIVE_BUNDLER');
      }

      if (!bundler.token_name) {
        throw new AppError('No token associated with bundler', 400, 'NO_TOKEN_FOUND');
      }

      const token = await tokenModel.getLatestTokenByUser(user_wallet_id);
      if (!token) {
        throw new AppError('No token found for user', 404, 'TOKEN_NOT_FOUND');
      }

      const bundlerWithWallets = await bundlerModel.getBundlerWithWallets(bundler.id);
      const childWallets = [];
      for (const motherWallet of bundlerWithWallets.mother_wallets) {
        childWallets.push(...motherWallet.child_wallets);
      }

      const sellableWallets = childWallets.filter(wallet => {
        const splBalance = parseFloat(wallet.balance_spl);
        return splBalance >= 0;
      });

      logger.info('Child wallet SPL balances for sell operation', {
        requestId,
        totalChildWallets: childWallets.length,
        sellableWallets: sellableWallets.length,
        walletBalances: childWallets.map(wallet => ({
          publicKey: wallet.public_key,
          splBalance: parseFloat(wallet.balance_spl),
          solBalance: parseFloat(wallet.balance_sol),
          willParticipateInSell: parseFloat(wallet.balance_spl) > 0
        }))
      });

      const totalSplBalance = childWallets.reduce((sum, wallet) => sum + parseFloat(wallet.balance_spl), 0);
      if (totalSplBalance === 0) {
        throw new AppError('No tokens to sell across all child wallets', 400, 'NO_TOKENS_TO_SELL');
      }

      const sellOperations = sellableWallets.map(wallet => {
        const splBalance = parseFloat(wallet.balance_spl);
        return {
          sellerPublicKey: wallet.public_key,
          mintAddress: token.contract_address,
          tokenAmount: `${sell_percent}%`,
          slippageBps: 100,
          privateKey: wallet.private_key,
          commitment: 'confirmed',
          _debugInfo: {
            currentSplBalance: splBalance,
            willSellAmount: (splBalance * sell_percent / 100).toFixed(6)
          }
        };
      });

      const sellResults = await pumpService.batchSell(
        sellOperations,
        `token-sell-${bundler.id}-${sell_percent}`
      );

      let successfulSellUpdates = 0;
      const sellWalletsNeedingVerification = [];
      const balanceAdjustments = [];

      for (let i = 0; i < sellResults.results.length; i++) {
        const result = sellResults.results[i];
        const wallet = sellableWallets[i];

        if (result?.success && result.data) {
          logger.info('Complete sell API response for debugging', {
            requestId,
            walletPublicKey: wallet.public_key,
            fullResponse: {
              signature: result.data?.signature,
              confirmed: result.data?.confirmed,
              postBalances: result.data?.postBalances,
              hasPostBalances: !!result.data?.postBalances,
              solData: result.data?.postBalances?.sol,
              splData: result.data?.postBalances?.spl
            }
          });

          const balances = ApiResponseValidator.extractTradeBalances(result.data);

          logger.info('Processing sell result for child wallet', {
            requestId,
            walletPublicKey: wallet.public_key,
            solBalance: balances.solBalance,
            splBalance: balances.splBalance,
            mintAddress: balances.mintAddress,
            signature: result.data?.signature
          });

          let finalSolBalance = balances.solBalance;
          let finalSplBalance = balances.splBalance;
          let shouldUpdateSplBalance = true;

          const originalSolBalance = parseFloat(wallet.balance_sol) || 0;
          const originalSplBalance = parseFloat(wallet.balance_spl) || 0;

          try {
            if (i > 0) {
              await new Promise(resolve => setTimeout(resolve, 500));
            }

            const actualSolBalance = await walletService.getSolBalance(
              wallet.public_key,
              { maxRetries: 2, logProgress: true }
            );

            finalSolBalance = actualSolBalance.balanceSol || 0;

            logger.info('Successfully retrieved real SOL balance from blockchain API after sell', {
              requestId,
              walletPublicKey: wallet.public_key,
              originalSolBalance,
              apiResponseSolBalance: balances.solBalance,
              blockchainActualSolBalance: finalSolBalance,
              signature: result.data.signature
            });
          } catch (solFallbackError) {
            logger.error('Blockchain API SOL balance fallback failed for sell - using API response', {
              requestId,
              walletPublicKey: wallet.public_key,
              signature: result.data.signature,
              error: solFallbackError.message,
              sellPercent: sell_percent,
              strategy: 'preserve_api_response'
            });

            finalSolBalance = balances.solBalance ?? originalSolBalance;
          }

          if ((balances.splBalance === 0 || balances.splBalance === null) && result.data?.signature) {
            logger.warn('Successful sell transaction but SPL balance is 0 - implementing recovery strategy', {
              requestId,
              walletPublicKey: wallet.public_key,
              signature: result.data.signature,
              sellPercent: sell_percent
            });

            try {
              if (i > 0) {
                await new Promise(resolve => setTimeout(resolve, 500));
              }

              const actualSplBalance = await walletService.getSplBalance(
                token.contract_address,
                wallet.public_key,
                { maxRetries: 2, logProgress: true }
              );

              finalSplBalance = actualSplBalance.uiAmount || actualSplBalance.balance || 0;

              logger.info('Successfully retrieved SPL balance from blockchain API for sell', {
                requestId,
                walletPublicKey: wallet.public_key,
                apiResponseBalance: balances.splBalance,
                blockchainActualBalance: finalSplBalance,
                signature: result.data.signature
              });
            } catch (fallbackError) {
              logger.error('Blockchain API fallback failed for sell - applying estimation safeguards', {
                requestId,
                walletPublicKey: wallet.public_key,
                signature: result.data.signature,
                error: fallbackError.message,
                sellPercent: sell_percent
              });

              if (sell_percent === 100) {
                finalSplBalance = 0;
              } else if (originalSplBalance > 0) {
                finalSplBalance = originalSplBalance * (1 - sell_percent / 100);

                logger.info('Calculated expected remaining SPL balance for sell', {
                  requestId,
                  walletPublicKey: wallet.public_key,
                  originalBalance: originalSplBalance,
                  sellPercent: sell_percent,
                  expectedRemaining: finalSplBalance,
                  signature: result.data.signature
                });
              } else {
                finalSplBalance = originalSplBalance;
                shouldUpdateSplBalance = false;

                sellWalletsNeedingVerification.push({
                  publicKey: wallet.public_key,
                  signature: result.data.signature,
                  sellPercent,
                  mintAddress: token.contract_address,
                  timestamp: new Date().toISOString(),
                  operation: 'sell'
                });
              }
            }
          }

          await walletModel.updateChildWalletBalances(
            wallet.public_key,
            finalSolBalance,
            finalSplBalance
          );

          logger.info('Child wallet balances updated after sell', {
            requestId,
            walletPublicKey: wallet.public_key,
            solBalance: finalSolBalance,
            splBalance: finalSplBalance,
            signature: result.data?.signature,
            solBalanceSource: 'blockchain_api_verified',
            splBalanceSource: shouldUpdateSplBalance ? 'api_or_fallback' : 'calculated_expected'
          });

          successfulSellUpdates++;
        } else {
          if (result?.error?.includes('Insufficient balance') || result?.error?.includes('INSUFFICIENT_BALANCE')) {
            const actualBalance = this.extractActualBalanceFromError(result.error);
            if (actualBalance !== null && actualBalance < parseFloat(wallet.balance_sol)) {
              balanceAdjustments.push({
                publicKey: wallet.public_key,
                newBalance: actualBalance
              });
            }
          }

          logger.error('Buy operation failed for child wallet', {
            requestId,
            walletPublicKey: wallet.public_key,
            error: result?.error,
            databaseBalance: parseFloat(wallet.balance_sol)
          });
        }
      }

      for (const adjustment of balanceAdjustments) {
        try {
          await walletModel.updateChildWalletSolBalance(adjustment.publicKey, adjustment.newBalance);
          logger.info('Updated child wallet balance based on blockchain feedback', {
            requestId,
            walletPublicKey: adjustment.publicKey,
            newBalance: adjustment.newBalance
          });
        } catch (error) {
          logger.error('Failed to update wallet balance', {
            requestId,
            walletPublicKey: adjustment.publicKey,
            error: error.message
          });
        }
      }

      if (sellWalletsNeedingVerification.length > 0) {
        logger.warn('Sell operations with SPL balance protection applied', {
          requestId,
          totalSellOperations: sellResults.results.length,
          successfulUpdates: successfulSellUpdates,
          walletsNeedingVerification: sellWalletsNeedingVerification.length,
          verificationDetails: sellWalletsNeedingVerification
        });
      }

      if (sell_percent === 100) {
        logger.info('100% sell - transferring SOL back and deactivating bundler', {
          requestId,
          user_wallet_id,
          distributorPublicKey
        });

        const updatedChildWallets = await bundlerModel.getChildWallets(bundler.id);

        const RENT_EXEMPTION = 0.00203928;
        const TRANSACTION_FEE = 0.000005;
        const MINIMUM_RESERVE = RENT_EXEMPTION + TRANSACTION_FEE;

        const walletsWithSol = updatedChildWallets.filter(wallet => {
          const balance = parseFloat(wallet.balance_sol);
          const transferableAmount = balance - MINIMUM_RESERVE;
          return transferableAmount > 0.0001;
        });

        if (walletsWithSol.length > 0) {
          const transferBackOperations = walletsWithSol.map(wallet => {
            const balance = parseFloat(wallet.balance_sol);
            const transferAmount = Math.max(balance - MINIMUM_RESERVE, 0);

            logger.info('Preparing SOL transfer back', {
              requestId,
              wallet: wallet.public_key,
              totalBalance: balance,
              reserveAmount: MINIMUM_RESERVE,
              transferAmount
            });

            return {
              fromPublicKey: wallet.public_key,
              toPublicKey: distributorPublicKey,
              amountSol: transferAmount,
              privateKey: wallet.private_key,
              commitment: 'confirmed'
            };
          });

          const transferResults = await solService.batchTransfer(
            transferBackOperations,
            `return-sol-${bundler.id}`,
            2000
          );

          logger.info('SOL transfer back completed', {
            requestId,
            successful: transferResults.successful,
            failed: transferResults.failed,
            totalOperations: transferBackOperations.length
          });

          if (transferResults.failed > 0) {
            logger.warn('Some SOL transfers failed during 100% sell cleanup', {
              requestId,
              failedCount: transferResults.failed,
              errors: transferResults.errors
            });
          }

          const newDistributorBalance = await walletService.getSolBalance(distributorPublicKey);
          await userModel.updateDistributorBalances(
            user_wallet_id,
            newDistributorBalance.balanceSol,
            user.distributor_balance_spl
          );

          logger.info('Updating child wallet balances after SOL transfer back to distributor', {
            requestId,
            walletsToUpdate: walletsWithSol.length,
            minimumReserve: MINIMUM_RESERVE
          });

          for (const wallet of walletsWithSol) {
            try {
              await walletModel.updateChildWalletSolBalance(wallet.public_key, MINIMUM_RESERVE);
              logger.info('Child wallet SOL balance updated after transfer back', {
                requestId,
                walletPublicKey: wallet.public_key,
                previousBalance: parseFloat(wallet.balance_sol),
                newBalance: MINIMUM_RESERVE
              });
            } catch (error) {
              logger.error('Failed to update child wallet balance after transfer back', {
                requestId,
                walletPublicKey: wallet.public_key,
                error: error.message
              });
            }
          }
        }

        await bundlerModel.deactivateBundler(bundler.id);
      }

      const finalBundler = await bundlerModel.getLatestActiveBundler(user_wallet_id);
      const remainingSpl = finalBundler ? finalBundler.total_balance_spl : '0';

      logger.info('Token sell completed', {
        requestId,
        bundler_id: bundler.id,
        sell_percent,
        successful: sellResults.successful,
        failed: sellResults.failed
      });

      res.json({
        bundler_id: bundler.id,
        sold_percent: sell_percent,
        remaining_spl: remainingSpl
      });
    } catch (error) {
      next(error);
    }
  }
  /**
   * Sell SPL tokens from user's in-app wallet
   * POST /api/orchestrator/sell-spl-from-wallet
   */
  async sellSplFromWallet(req, res, next) {
    const startTime = Date.now();
    const requestId = uuidv4();

    try {
      const { user_wallet_id, sell_percent, wallet_type } = req.body;
      const walletType = (wallet_type || 'distributor').toLowerCase() === 'developer'
        ? 'developer'
        : 'distributor';

      logger.info('🚀 [SELL_SPL_FROM_WALLET] Request started', {
        requestId,
        user_wallet_id,
        sell_percent,
        wallet_type: walletType,
        timestamp: new Date().toISOString(),
        endpoint: 'POST /api/orchestrator/sell-spl-from-wallet',
        ip: req.ip,
        userAgent: req.get('User-Agent')
      });

      // Step 1: Validate input
      if (!user_wallet_id) {
        logger.error('❌ [SELL_SPL_FROM_WALLET] Missing user_wallet_id', {
          requestId,
          body: req.body
        });
        throw new AppError('user_wallet_id is required', 400, 'MISSING_USER_WALLET_ID');
      }

      if (!sell_percent || sell_percent <= 0 || sell_percent > 100) {
        logger.error('❌ [SELL_SPL_FROM_WALLET] Invalid sell_percent', {
          requestId,
          sell_percent,
          body: req.body
        });
        throw new AppError('sell_percent must be between 1 and 100', 400, 'INVALID_SELL_PERCENT');
      }

      logger.info('✅ [SELL_SPL_FROM_WALLET] Input validation passed', {
        requestId,
        user_wallet_id,
        sell_percent
      });

      // Step 2: Get latest token for user from database
      logger.info('🔍 [SELL_SPL_FROM_WALLET] Getting latest token for user', {
        requestId,
        user_wallet_id
      });

      const token = await tokenModel.getLatestTokenByUser(user_wallet_id);
      if (!token) {
        logger.error('❌ [SELL_SPL_FROM_WALLET] No token found for user', {
          requestId,
          user_wallet_id
        });
        throw new AppError('No token found for user', 404, 'TOKEN_NOT_FOUND');
      }

      const token_contract_address = token.contract_address;

      logger.info('✅ [SELL_SPL_FROM_WALLET] Latest token retrieved', {
        requestId,
        user_wallet_id,
        token_id: token.id,
        token_symbol: token.symbol,
        token_contract_address,
        token_created_at: token.created_at
      });

      // Step 3: Get user data
      logger.info('🔍 [SELL_SPL_FROM_WALLET] Getting user data', {
        requestId,
        user_wallet_id
      });

      const user = await userModel.getUserByWalletId(user_wallet_id);
      if (!user) {
        logger.error('❌ [SELL_SPL_FROM_WALLET] User not found', {
          requestId,
          user_wallet_id
        });
        throw new AppError('User not found', 404, 'USER_NOT_FOUND');
      }

      const { publicKey: distributorPublicKey, privateKey: distributorPrivateKey } = getDistributorWallet(user);

      const walletContext = walletType === 'developer'
        ? {
            type: 'developer',
            publicKey: user?.dev_public_key,
            privateKey: user?.dev_private_key,
            dbSol: Number(user?.dev_balance_sol ?? 0),
            dbSpl: Number(user?.dev_balance_spl ?? 0),
            updateBalances: (sol, spl) => userModel.updateDevBalances(user_wallet_id, sol, spl),
            updateSolOnly: (sol) => userModel.updateDevBalances(
              user_wallet_id,
              sol,
              Number(user?.dev_balance_spl ?? 0)
            )
          }
        : {
            type: 'distributor',
            publicKey: distributorPublicKey,
            privateKey: distributorPrivateKey,
            dbSol: getDistributorBalanceSol(user),
            dbSpl: Number(user?.balance_spl ?? user?.distributor_balance_spl ?? 0),
            updateBalances: (sol, spl) => userModel.updateBalances(user_wallet_id, sol, spl),
            updateSolOnly: (sol) => userModel.updateSolBalance(user_wallet_id, sol)
          };

      if (!walletContext.publicKey || !walletContext.privateKey) {
        logger.error('❌ [SELL_SPL_FROM_WALLET] Requested wallet type not provisioned', {
          requestId,
          user_wallet_id,
          wallet_type: walletContext.type,
          has_public_key: Boolean(walletContext.publicKey),
          has_private_key: Boolean(walletContext.privateKey)
        });

        throw new AppError(
          walletContext.type === 'developer'
            ? 'Developer wallet not ready yet. Please retry once provisioning completes.'
            : 'User does not have an in-app wallet',
          walletContext.type === 'developer' ? 409 : 400,
          walletContext.type === 'developer' ? 'DEV_WALLET_NOT_READY' : 'NO_IN_APP_WALLET'
        );
      }

      logger.info('✅ [SELL_SPL_FROM_WALLET] User wallet resolved', {
        requestId,
        user_wallet_id,
        wallet_type: walletContext.type,
        wallet_public_key: walletContext.publicKey,
        stored_sol_balance: walletContext.dbSol,
        stored_spl_balance: walletContext.dbSpl
      });

      // Step 4: Get current SPL token balance from blockchain
      logger.info('🔗 [SELL_SPL_FROM_WALLET] Getting current SPL balance from blockchain', {
        requestId,
        user_wallet_id,
        wallet_type: walletContext.type,
        wallet_public_key: walletContext.publicKey,
        token_contract_address
      });

      const balanceCheckStart = Date.now();
      const splBalanceData = await walletService.getSplBalance(
        token_contract_address, 
        walletContext.publicKey,
        { maxRetries: 3, logProgress: true }
      );
      const balanceCheckTime = Date.now() - balanceCheckStart;

      const currentSplBalance = splBalanceData.uiAmount || splBalanceData.balance || 0;

      logger.info('✅ [SELL_SPL_FROM_WALLET] SPL balance retrieved', {
        requestId,
        user_wallet_id,
        token_contract_address,
        current_spl_balance: currentSplBalance,
        balance_check_time_ms: balanceCheckTime,
        raw_balance_data: splBalanceData
      });

      // Step 5: Validate sufficient SPL balance
      if (currentSplBalance <= 0) {
        logger.error('❌ [SELL_SPL_FROM_WALLET] No SPL tokens to sell', {
          requestId,
          user_wallet_id,
          token_contract_address,
          current_spl_balance: currentSplBalance
        });
        throw new AppError('No SPL tokens available to sell', 400, 'NO_SPL_TOKENS_TO_SELL');
      }

      const sellAmount = (currentSplBalance * sell_percent) / 100;
      const MIN_SELL_AMOUNT = 0.000001; // Minimum SPL amount to sell

      if (sellAmount < MIN_SELL_AMOUNT) {
        logger.error('❌ [SELL_SPL_FROM_WALLET] Sell amount too small', {
          requestId,
          user_wallet_id,
          current_spl_balance: currentSplBalance,
          sell_percent,
          calculated_sell_amount: sellAmount,
          min_sell_amount: MIN_SELL_AMOUNT
        });
        throw new AppError(
          `Sell amount too small. Current balance: ${currentSplBalance}, calculated sell: ${sellAmount}`,
          400,
          'SELL_AMOUNT_TOO_SMALL'
        );
      }

      logger.info('✅ [SELL_SPL_FROM_WALLET] SPL balance validation passed', {
        requestId,
        user_wallet_id,
        current_spl_balance: currentSplBalance,
        sell_percent,
        calculated_sell_amount: sellAmount
      });

      // Step 6: Execute sell operation via Pump.fun
      logger.info('🔗 [SELL_SPL_FROM_WALLET] Executing sell operation via Pump.fun', {
        requestId,
        user_wallet_id,
        wallet_type: walletContext.type,
        wallet_public_key: walletContext.publicKey,
        token_contract_address,
        sell_percent_string: `${sell_percent}%`,
        expected_sell_amount: sellAmount
      });

      const sellOperationStart = Date.now();
      const sellData = {
        sellerPublicKey: walletContext.publicKey,
        mintAddress: token_contract_address,
        tokenAmount: `${sell_percent}%`, // API accepts percentage format
        slippageBps: 100, // 1% slippage for sells
        privateKey: walletContext.privateKey,
        commitment: 'confirmed'
      };

      const sellResult = await pumpService.sell(sellData);
      const sellOperationTime = Date.now() - sellOperationStart;

      logger.info('✅ [SELL_SPL_FROM_WALLET] Sell operation completed', {
        requestId,
        user_wallet_id,
        sell_operation_time_ms: sellOperationTime,
        signature: sellResult.signature,
        confirmed: sellResult.confirmed
      });

      // Step 7: Extract and update balances from sell result
      logger.info('📊 [SELL_SPL_FROM_WALLET] Extracting balances from sell result', {
        requestId,
        user_wallet_id,
        sell_result_signature: sellResult.signature
      });

      const balances = ApiResponseValidator.extractTradeBalances(sellResult);

      logger.info('✅ [SELL_SPL_FROM_WALLET] Balances extracted from sell result', {
        requestId,
        user_wallet_id,
        extracted_sol_balance: balances.solBalance,
        extracted_spl_balance: balances.splBalance,
        mint_address: balances.mintAddress,
        signature: sellResult.signature
      });

      // Step 8: Update user balances in database with fallback protection
      let finalSplBalance = balances.splBalance;
      let shouldUpdateSplBalance = true;

      // Enhanced fallback strategy for SPL balance issues
      if (balances.splBalance === 0 && sellResult.signature) {
        logger.warn('⚠️ [SELL_SPL_FROM_WALLET] API returned 0 SPL balance - implementing recovery strategy', {
          requestId,
          user_wallet_id,
          signature: sellResult.signature,
          sell_percent,
          original_balance: currentSplBalance,
          strategy: 'calculate_expected_remaining'
        });

        try {
          // Try blockchain API fallback first
          const actualSplBalance = await walletService.getSplBalance(
            token_contract_address, 
            walletContext.publicKey,
            { maxRetries: 2, logProgress: true }
          );
          
          finalSplBalance = actualSplBalance.uiAmount || actualSplBalance.balance || 0;
          
          logger.info('✅ [SELL_SPL_FROM_WALLET] Successfully retrieved SPL balance from blockchain API', {
            requestId,
            user_wallet_id,
            api_response_balance: balances.splBalance,
            blockchain_actual_balance: finalSplBalance,
            signature: sellResult.signature
          });
          
        } catch (fallbackError) {
          logger.error('❌ [SELL_SPL_FROM_WALLET] Blockchain API fallback failed - calculating expected balance', {
            requestId,
            user_wallet_id,
            signature: sellResult.signature,
            error: fallbackError.message,
            sell_percent,
            strategy: 'calculate_expected_remaining'
          });
          
          // Calculate expected remaining balance based on sell percentage
          if (sell_percent === 100) {
            finalSplBalance = 0;
            logger.info('📊 [SELL_SPL_FROM_WALLET] 100% sell - setting SPL balance to 0', {
              requestId,
              user_wallet_id,
              signature: sellResult.signature
            });
          } else {
            // For partial sells, calculate expected remaining
            const expectedRemaining = currentSplBalance * (1 - sell_percent / 100);
            finalSplBalance = expectedRemaining;
            
            logger.info('📊 [SELL_SPL_FROM_WALLET] Calculated expected remaining SPL balance', {
              requestId,
              user_wallet_id,
              original_balance: currentSplBalance,
              sell_percent,
              expected_remaining: expectedRemaining,
              signature: sellResult.signature
            });
          }
        }
      }

      // Update user balances in database
      const balanceUpdateStart = Date.now();
      if (shouldUpdateSplBalance) {
        await walletContext.updateBalances(balances.solBalance, finalSplBalance);

        logger.info('✅ [SELL_SPL_FROM_WALLET] Updated SOL and SPL balances', {
          requestId,
          user_wallet_id,
          wallet_type: walletContext.type,
          new_sol_balance: balances.solBalance,
          new_spl_balance: finalSplBalance,
          signature: sellResult.signature
        });
      } else {
        await walletContext.updateSolOnly(balances.solBalance);

        logger.info('✅ [SELL_SPL_FROM_WALLET] Updated SOL balance only, preserved existing SPL balance', {
          requestId,
          user_wallet_id,
          wallet_type: walletContext.type,
          new_sol_balance: balances.solBalance,
          signature: sellResult.signature,
          note: 'SPL balance preserved due to API issues'
        });
      }
      const balanceUpdateTime = Date.now() - balanceUpdateStart;

      // Step 9: Prepare response
      const totalTime = Date.now() - startTime;
      const response = {
        transaction_signature: sellResult.signature,
        sell_percent: sell_percent,
        sold_amount_spl: sellAmount,
        remaining_spl_balance: finalSplBalance,
        new_sol_balance: balances.solBalance,
        token_contract_address: token_contract_address,
        wallet_type: walletContext.type,
        wallet_public_key: walletContext.publicKey
      };

      logger.info('🎉 [SELL_SPL_FROM_WALLET] Request completed successfully', {
        requestId,
        user_wallet_id,
        wallet_type: walletContext.type,
        token_contract_address,
        sell_percent,
        total_time_ms: totalTime,
        balance_check_time_ms: balanceCheckTime,
        sell_operation_time_ms: sellOperationTime,
        balance_update_time_ms: balanceUpdateTime,
        response_data: response
      });

      res.json(response);

    } catch (error) {
      const totalTime = Date.now() - startTime;
      
      logger.error('❌ [SELL_SPL_FROM_WALLET] Request failed', {
        requestId,
        user_wallet_id: req.body?.user_wallet_id || 'unknown',
        sell_percent: req.body?.sell_percent || 'unknown',
        error_code: error.code || 'UNKNOWN_ERROR',
        error_message: error.message,
        error_stack: error.stack,
        total_time_ms: totalTime,
        timestamp: new Date().toISOString()
      });

      // Log additional context for specific error types
      if (error.code === 'TOKEN_NOT_FOUND') {
        logger.warn('⚠️ [SELL_SPL_FROM_WALLET] User has no tokens to sell', {
          requestId,
          user_wallet_id: req.body?.user_wallet_id,
          error_details: 'No tokens found in database for this user'
        });
      } else if (error.code === 'NO_SPL_TOKENS_TO_SELL') {
        logger.warn('⚠️ [SELL_SPL_FROM_WALLET] User attempted to sell SPL tokens with zero balance', {
          requestId,
          user_wallet_id: req.body?.user_wallet_id
        });
      } else if (error.code === 'EXTERNAL_PUMP_SELL_ERROR') {
        logger.error('🔗 [SELL_SPL_FROM_WALLET] Pump.fun API failure', {
          requestId,
          user_wallet_id: req.body?.user_wallet_id,
          error_details: 'Failed to sell SPL tokens via Pump.fun API'
        });
      }

      next(error);
    }
  }

  /**
   * Verify user SPL balance after token creation
   * POST /api/orchestrator/verify-user-spl-balance
   */
  async verifyUserSplBalance(req, res, next) {
    const startTime = Date.now();
    const requestId = uuidv4();

    try {
      const { user_wallet_id } = req.body;

      logger.info('🚀 [VERIFY_USER_SPL_BALANCE] Request started', {
        requestId,
        user_wallet_id,
        timestamp: new Date().toISOString(),
        endpoint: 'POST /api/orchestrator/verify-user-spl-balance',
        ip: req.ip,
        userAgent: req.get('User-Agent')
      });

      // Step 1: Validate input
      if (!user_wallet_id) {
        logger.error('❌ [VERIFY_USER_SPL_BALANCE] Missing user_wallet_id', {
          requestId,
          body: req.body
        });
        throw new AppError('user_wallet_id is required', 400, 'MISSING_USER_WALLET_ID');
      }

      // Step 2: Get user data
      const user = await userModel.getUserByWalletId(user_wallet_id);
      if (!user) {
        throw new AppError('User not found', 404, 'USER_NOT_FOUND');
      }

      const { publicKey: distributorPublicKey } = getDistributorWallet(user);
      if (!distributorPublicKey) {
        throw new AppError('User does not have an in-app wallet', 400, 'NO_IN_APP_WALLET');
      }

      // Step 3: Get latest token for user
      const token = await tokenModel.getLatestTokenByUser(user_wallet_id);
      if (!token) {
        throw new AppError('No token found for user', 404, 'TOKEN_NOT_FOUND');
      }

      const contractAddress = token.contract_address;

      logger.info('✅ [VERIFY_USER_SPL_BALANCE] Token found for verification', {
        requestId,
        user_wallet_id,
        contractAddress,
        tokenSymbol: token.symbol,
        currentSplBalance: user.balance_spl
      });

      // Step 4: Get actual SPL balance from blockchain
      const balanceCheckStart = Date.now();
      const actualSplBalance = await walletService.getSplBalance(
        contractAddress,
        distributorPublicKey,
        { maxRetries: 5, logProgress: true }
      );
      const balanceCheckTime = Date.now() - balanceCheckStart;

      const verifiedBalance = actualSplBalance.uiAmount || actualSplBalance.balance || 0;

      logger.info('✅ [VERIFY_USER_SPL_BALANCE] SPL balance retrieved from blockchain', {
        requestId,
        user_wallet_id,
        contractAddress,
        currentDbBalance: user.balance_spl,
        verifiedBlockchainBalance: verifiedBalance,
        balanceCheckTime
      });

      // Step 5: Update database if balance is different
      let balanceUpdated = false;
      const currentDbBalance = parseFloat(user.balance_spl) || 0;
      
      if (Math.abs(currentDbBalance - verifiedBalance) > 0.000001) { // Tolerance for floating point comparison
        await userModel.updateSplBalance(user_wallet_id, verifiedBalance);
        balanceUpdated = true;

        logger.info('✅ [VERIFY_USER_SPL_BALANCE] User SPL balance updated', {
          requestId,
          user_wallet_id,
          previousBalance: currentDbBalance,
          newBalance: verifiedBalance,
          difference: verifiedBalance - currentDbBalance
        });
      } else {
        logger.info('ℹ️ [VERIFY_USER_SPL_BALANCE] Balance already accurate, no update needed', {
          requestId,
          user_wallet_id,
          currentBalance: verifiedBalance
        });
      }

      // Step 6: Prepare response
      const totalTime = Date.now() - startTime;
      const response = {
        user_wallet_id,
        token_contract_address: contractAddress,
        token_symbol: token.symbol,
        previous_spl_balance: currentDbBalance,
        verified_spl_balance: verifiedBalance,
        balance_updated: balanceUpdated,
        balance_difference: verifiedBalance - currentDbBalance,
        verification_time_ms: totalTime
      };

      logger.info('🎉 [VERIFY_USER_SPL_BALANCE] Request completed successfully', {
        requestId,
        user_wallet_id,
        contractAddress,
        totalTime,
        balanceCheckTime,
        balanceUpdated,
        response
      });

      res.json(response);

    } catch (error) {
      const totalTime = Date.now() - startTime;
      
      logger.error('❌ [VERIFY_USER_SPL_BALANCE] Request failed', {
        requestId,
        user_wallet_id: req.body?.user_wallet_id || 'unknown',
        error_code: error.code || 'UNKNOWN_ERROR',
        error_message: error.message,
        error_stack: error.stack,
        totalTime,
        timestamp: new Date().toISOString()
      });

      next(error);
    }
  }

  /**
   * Verify developer wallet SOL balance
   * POST /api/orchestrator/verify-dev-wallet-balance
   */
  async verifyDevWalletBalance(req, res, next) {
    const startTime = Date.now();
    const requestId = uuidv4();

    try {
      const { user_wallet_id } = req.body;

      logger.info('🚀 [VERIFY_DEV_WALLET_BALANCE] Request started', {
        requestId,
        user_wallet_id,
        endpoint: 'POST /api/orchestrator/verify-dev-wallet-balance'
      });

      const user = await userModel.getUserByWalletId(user_wallet_id);
      if (!user) {
        throw new AppError('User not found', 404, 'USER_NOT_FOUND');
      }

      const devPublicKey = user?.dev_public_key;
      if (!devPublicKey) {
        logger.warn('⚠️ [VERIFY_DEV_WALLET_BALANCE] Dev wallet not provisioned yet', {
          requestId,
          user_wallet_id,
          has_dev_public_key: Boolean(user?.dev_public_key)
        });
        throw new AppError(
          'Developer wallet not ready yet. Please retry after provisioning completes.',
          409,
          'DEV_WALLET_NOT_READY'
        );
      }

      const previousBalance = Number(user?.dev_balance_sol ?? 0);
      const currentSplBalance = Number(user?.dev_balance_spl ?? 0);

      logger.info('🔗 [VERIFY_DEV_WALLET_BALANCE] Fetching on-chain SOL balance for dev wallet', {
        requestId,
        user_wallet_id,
        dev_public_key: devPublicKey
      });

      const balanceCheckStart = Date.now();
      const balanceData = await walletService.getSolBalance(devPublicKey, {
        maxRetries: 3,
        logProgress: true
      });
      const balanceCheckTime = Date.now() - balanceCheckStart;

      const currentBalance = Number(balanceData?.balanceSol ?? balanceData?.balance_sol ?? 0);

      logger.info('✅ [VERIFY_DEV_WALLET_BALANCE] Balance retrieved', {
        requestId,
        user_wallet_id,
        dev_public_key: devPublicKey,
        previous_balance: previousBalance,
        current_balance: currentBalance,
        balance_check_time_ms: balanceCheckTime
      });

      await userModel.updateDevBalances(user_wallet_id, currentBalance, currentSplBalance);

      const balanceDifference = currentBalance - previousBalance;
      const balanceUpdated = Math.abs(balanceDifference) > 0.000001;
      const totalTime = Date.now() - startTime;

      const response = {
        user_wallet_id,
        dev_public_key: devPublicKey,
        previous_balance_sol: previousBalance.toString(),
        current_balance_sol: currentBalance.toString(),
        balance_difference_sol: balanceDifference,
        balance_updated: balanceUpdated,
        verification_time_ms: totalTime
      };

      logger.info('🎉 [VERIFY_DEV_WALLET_BALANCE] Request completed successfully', {
        requestId,
        user_wallet_id,
        dev_public_key: devPublicKey,
        total_time_ms: totalTime,
        balance_updated: balanceUpdated,
        response
      });

      res.json(response);
    } catch (error) {
      logger.error('❌ [VERIFY_DEV_WALLET_BALANCE] Request failed', {
        requestId,
        user_wallet_id: req.body?.user_wallet_id || 'unknown',
        error_code: error.code || 'UNKNOWN_ERROR',
        error_message: error.message
      });
      next(error);
    }
  }

  /**
   * Verify in-app SOL balance
   * POST /api/orchestrator/verify-in-app-sol-balance
   */
  async verifyInAppSolBalance(req, res, next) {
    try {
      const { user_wallet_id } = req.body;

      logger.info('Verifying in-app SOL balance', { user_wallet_id });

      // Get user data
      const user = await userModel.getUserByWalletId(user_wallet_id);
      if (!user) {
        throw new AppError('User not found', 404, 'USER_NOT_FOUND');
      }

      const { publicKey: inAppPublicKey } = getDistributorWallet(user);
      if (!inAppPublicKey) {
        logger.warn('Verify balance called for user without distributor wallet', {
          user_wallet_id,
          user_has_distributor_public_key: Boolean(user.distributor_public_key),
          user_has_legacy_in_app_public_key: Boolean(user.in_app_public_key)
        });
        throw new AppError('User does not have an in-app wallet', 400, 'NO_IN_APP_WALLET');
      }

      const previousBalance = getDistributorBalanceSol(user);

      // Get current balance from blockchain API
      logger.info('Fetching balance from blockchain API', { 
        in_app_public_key: inAppPublicKey, 
        user_wallet_id 
      });

      const balanceData = await walletService.getSolBalance(inAppPublicKey);
      const currentBalance = Number(
        balanceData?.balanceSol ?? balanceData?.balance_sol ?? 0
      );

      // Update balance in database
      await userModel.updateSolBalance(user_wallet_id, currentBalance);

      logger.info('In-app SOL balance verified and updated', {
        user_wallet_id,
        previous_balance: previousBalance,
        current_balance: currentBalance,
        in_app_public_key: inAppPublicKey
      });

      res.json({
        user_wallet_id,
        distributor_public_key: inAppPublicKey,
        previous_balance_sol: previousBalance.toString(),
        current_balance_sol: currentBalance.toString(),
        balance_updated: true
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Transfer SOL to owner wallet
   * POST /api/orchestrator/transfer-to-owner-wallet
   */
  async transferToOwnerWallet(req, res, next) {
    try {
      const { user_wallet_id, amount_sol } = req.body;

      logger.info('Transferring SOL to owner wallet', { user_wallet_id, amount_sol });

      // Get user data
      const user = await userModel.getUserByWalletId(user_wallet_id);
      if (!user) {
        throw new AppError('User not found', 404, 'USER_NOT_FOUND');
      }

      const { publicKey: distributorPublicKey, privateKey: distributorPrivateKey } = getDistributorWallet(user);

      if (!distributorPublicKey || !distributorPrivateKey) {
        throw new AppError('User does not have an in-app wallet', 400, 'NO_IN_APP_WALLET');
      }

      // Get current in-app wallet balance
      const balanceData = await walletService.getSolBalance(distributorPublicKey);
      const currentBalance = Number(balanceData?.balanceSol ?? balanceData?.balance_sol ?? 0);

      // Validate sufficient balance
      const transferAmount = parseFloat(amount_sol);
      if (currentBalance < transferAmount + 0.000005) { // Add buffer for fees
        throw new AppError(
          `Insufficient balance. Available: ${currentBalance} SOL, Requested: ${transferAmount} SOL`,
          402,
          'INSUFFICIENT_BALANCE'
        );
      }

      // Execute transfer
      logger.info('Executing transfer to owner wallet');
      
      const transferResult = await solService.transfer({
        fromPublicKey: distributorPublicKey,
        toPublicKey: user_wallet_id,
        amountSol: transferAmount,
        privateKey: distributorPrivateKey,
        commitment: 'confirmed'
      }, `transfer-to-owner-${user_wallet_id}-${Date.now()}`);

      // Update user balance
      const newBalance = await walletService.getSolBalance(distributorPublicKey);
      const newBalanceSol = Number(newBalance?.balanceSol ?? newBalance?.balance_sol ?? 0);
      await userModel.updateSolBalance(user_wallet_id, newBalanceSol);

      logger.info('Transfer to owner wallet completed', {
        user_wallet_id,
        amount_sol: transferAmount,
        txid: transferResult.signature,
        new_balance: newBalanceSol
      });

      res.json({
        txid: transferResult.signature,
        new_balance_sol: newBalanceSol.toString()
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Generate random distribution for child wallets - distribute to ALL child wallets
   * Each wallet must receive between 0.2 and 0.3 SOL, with total sum equal to totalAmount.
   * Typical configuration: 1 child wallet per mother (fallback supports >1).
   * @param {number} walletCount - Number of child wallets
   * @param {number} totalAmount - Total amount to distribute (e.g., ~0.99 SOL for multi-child fallback)
   * @returns {Array<number>} Array of amounts for each wallet
   */
  static generateRandomDistribution(walletCount, totalAmount) {
    const MIN_AMOUNT = 0.2;  // Minimum amount per child wallet
    const MAX_AMOUNT = 0.3;  // Maximum amount per child wallet
    
    // Validate that the constraints are feasible
    const minTotal = MIN_AMOUNT * walletCount;
    const maxTotal = MAX_AMOUNT * walletCount;
    
    if (totalAmount < minTotal || totalAmount > maxTotal) {
      logger.warn('Total amount outside feasible range for constraints', {
        totalAmount,
        walletCount,
        minTotal,
        maxTotal,
        minPerWallet: MIN_AMOUNT,
        maxPerWallet: MAX_AMOUNT
      });
      
      // Fallback to proportional distribution if constraints can't be met
      const fallbackAmount = totalAmount / walletCount;
      return new Array(walletCount).fill(fallbackAmount);
    }
    
    const distributions = new Array(walletCount);
    let remainingAmount = totalAmount;
    
    // Generate amounts for first (n-1) wallets within constraints
    for (let i = 0; i < walletCount - 1; i++) {
      const remainingWallets = walletCount - i;
      const maxForThisWallet = Math.min(MAX_AMOUNT, remainingAmount - MIN_AMOUNT * (remainingWallets - 1));
      const minForThisWallet = Math.max(MIN_AMOUNT, remainingAmount - MAX_AMOUNT * (remainingWallets - 1));
      
      // Generate random amount within the valid range for this wallet
      const amount = minForThisWallet + Math.random() * (maxForThisWallet - minForThisWallet);
      distributions[i] = amount;
      remainingAmount -= amount;
    }
    
    // Last wallet gets exactly the remaining amount (which should be within constraints)
    distributions[walletCount - 1] = remainingAmount;
    
    // Verify all constraints are met
    const actualTotal = distributions.reduce((sum, amount) => sum + amount, 0);
    const allWithinRange = distributions.every(amount => amount >= MIN_AMOUNT && amount <= MAX_AMOUNT);
    
    if (!allWithinRange || Math.abs(actualTotal - totalAmount) > 0.000001) {
      logger.error('Distribution constraints validation failed', {
        distributions: distributions.map(amount => amount.toFixed(9)),
        actualTotal: actualTotal.toFixed(9),
        expectedTotal: totalAmount.toFixed(9),
        totalDifference: (actualTotal - totalAmount).toFixed(9),
        allWithinRange,
        minAmount: MIN_AMOUNT,
        maxAmount: MAX_AMOUNT
      });
    }

    logger.info('Generated constrained distribution for child wallets', {
      walletCount,
      totalAmount: totalAmount.toFixed(9),
      actualTotal: actualTotal.toFixed(9),
      minAmount: MIN_AMOUNT,
      maxAmount: MAX_AMOUNT,
      distributions: distributions.map((amount, index) => ({ 
        wallet: index, 
        amount: amount.toFixed(9),
        withinRange: amount >= MIN_AMOUNT && amount <= MAX_AMOUNT
      }))
    });

    return distributions;
  }

   /**
    * Extract actual balance from error message
    * @param {string} errorMessage - Error message containing balance info
    * @returns {number|null} Actual balance in SOL or null if not found
    */
   extractActualBalanceFromError(errorMessage) {
     try {
       // Look for pattern: "actual balance 0.048925568 SOL"
       const match = errorMessage.match(/actual balance ([\d.]+) SOL/);
       if (match) {
         return parseFloat(match[1]);
       }
       
       // Alternative pattern: "insufficient lamports 48925568, need 50972165"
       const lamportsMatch = errorMessage.match(/insufficient lamports (\d+), need (\d+)/);
       if (lamportsMatch) {
         const actualLamports = parseInt(lamportsMatch[1]);
         return actualLamports / 1000000000; // Convert lamports to SOL
       }
       
       return null;
     } catch (error) {
       logger.warn('Could not extract balance from error message', { 
         errorMessage, 
         extractionError: error.message 
       });
       return null;
     }
   }

   /**
    * Verify and fix SPL balances for specific wallets
    * This method can be called separately to fix SPL balances that were missed due to API issues
    * Supports both buy and sell operations
    * @param {Array} walletVerifications - Array of wallet verification objects
    * @param {string} mintAddress - Token contract address
    * @returns {Promise<Object>} Verification results
    */
   async verifySplBalances(walletVerifications, mintAddress) {
     try {
       logger.info('Starting SPL balance verification process', {
         walletsToVerify: walletVerifications.length,
         mintAddress,
         wallets: walletVerifications.map(w => w.publicKey)
       });

       const verificationResults = [];
       let successfulVerifications = 0;
       let failedVerifications = 0;

       for (let i = 0; i < walletVerifications.length; i++) {
         const walletInfo = walletVerifications[i];
         
         try {
           // Add delay between requests
           if (i > 0) {
             await new Promise(resolve => setTimeout(resolve, 1000)); // 1 second delay
           }

           logger.info('Verifying SPL balance for wallet', {
             walletPublicKey: walletInfo.publicKey,
             originalSignature: walletInfo.signature,
             operation: walletInfo.operation || 'buy',
             sellPercent: walletInfo.sellPercent,
             mintAddress
           });

           // Try to get the actual SPL balance
           const actualBalance = await walletService.getSplBalance(
             mintAddress,
             walletInfo.publicKey,
             { maxRetries: 3, logProgress: true }
           );

           const currentDbBalance = await walletModel.getChildWalletSplBalance(walletInfo.publicKey);
           const actualSplBalance = actualBalance.uiAmount || actualBalance.balance || 0;

           if (actualSplBalance > 0 && actualSplBalance !== currentDbBalance) {
             // Update the database with the correct balance
             await walletModel.updateChildWalletSplBalance(
               walletInfo.publicKey,
               actualSplBalance
             );

             logger.info('SPL balance corrected via verification', {
               walletPublicKey: walletInfo.publicKey,
               previousDbBalance: currentDbBalance,
               correctedBalance: actualSplBalance,
               originalSignature: walletInfo.signature
             });

             verificationResults.push({
               walletPublicKey: walletInfo.publicKey,
               status: 'corrected',
               previousBalance: currentDbBalance,
               correctedBalance: actualSplBalance,
               signature: walletInfo.signature
             });

             successfulVerifications++;
           } else {
             logger.info('SPL balance verification - no correction needed', {
               walletPublicKey: walletInfo.publicKey,
               currentDbBalance,
               blockchainBalance: actualSplBalance
             });

             verificationResults.push({
               walletPublicKey: walletInfo.publicKey,
               status: 'no_correction_needed',
               currentBalance: currentDbBalance,
               blockchainBalance: actualSplBalance
             });

             successfulVerifications++;
           }

         } catch (error) {
           logger.error('Failed to verify SPL balance for wallet', {
             walletPublicKey: walletInfo.publicKey,
             error: error.message,
             originalSignature: walletInfo.signature
           });

           verificationResults.push({
             walletPublicKey: walletInfo.publicKey,
             status: 'failed',
             error: error.message,
             signature: walletInfo.signature
           });

           failedVerifications++;
         }
       }

       logger.info('SPL balance verification completed', {
         totalWallets: walletVerifications.length,
         successfulVerifications,
         failedVerifications,
         correctedWallets: verificationResults.filter(r => r.status === 'corrected').length
       });

       return {
         totalWallets: walletVerifications.length,
         successfulVerifications,
         failedVerifications,
         results: verificationResults
       };

     } catch (error) {
       logger.error('SPL balance verification process failed', {
         error: error.message,
         mintAddress,
         walletsToVerify: walletVerifications.length
       });
       throw error;
     }
   }
}

module.exports = new OrchestratorController();
