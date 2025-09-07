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

class OrchestratorController {
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
      
      if (existingUser) {
        logger.info('📋 [CREATE_WALLET_IN_APP] User found in database', {
          requestId,
          user_wallet_id,
          has_in_app_wallet: !!existingUser.in_app_public_key,
          existing_public_key: existingUser.in_app_public_key ? 'exists' : 'none'
        });

        if (existingUser.in_app_public_key) {
          logger.warn('⚠️ [CREATE_WALLET_IN_APP] User already has an in-app wallet', {
            requestId,
            user_wallet_id,
            existing_public_key: existingUser.in_app_public_key
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
      
      const wallet = walletData[0]; // First wallet from array

      logger.info('✅ [CREATE_WALLET_IN_APP] Blockchain API call successful', {
        requestId,
        user_wallet_id,
        wallet_creation_time_ms: walletCreationTime,
        public_key_created: wallet.publicKey,
        private_key_exists: !!wallet.privateKey
      });

      // Step 4: Store user data in database
      logger.info('💾 [CREATE_WALLET_IN_APP] Storing user data in database', {
        requestId,
        user_wallet_id,
        in_app_public_key: wallet.publicKey
      });

      const dbInsertStart = Date.now();
      await userModel.createUser(
        user_wallet_id,
        wallet.privateKey,
        wallet.publicKey
      );
      const dbInsertTime = Date.now() - dbInsertStart;

      logger.info('✅ [CREATE_WALLET_IN_APP] User data stored successfully', {
        requestId,
        user_wallet_id,
        in_app_public_key: wallet.publicKey,
        db_insert_time_ms: dbInsertTime
      });

      // Step 5: Send success notification to frontend (optional - non-blocking)
      logger.info('📢 [CREATE_WALLET_IN_APP] Sending notification to frontend', {
        requestId,
        user_wallet_id,
        in_app_public_key: wallet.publicKey,
        frontend_url: process.env.FRONTEND_URL || 'https://frontend-solanified.vercel.app'
      });

      const notificationStart = Date.now();
      try {
        await notificationService.sendWalletCreationNotification(
          user_wallet_id,
          wallet.publicKey
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
      const totalTime = Date.now() - startTime;
      const response = {
        in_app_public_key: wallet.publicKey,
        balance_sol: "0"
      };

      logger.info('🎉 [CREATE_WALLET_IN_APP] Request completed successfully', {
        requestId,
        user_wallet_id,
        in_app_public_key: wallet.publicKey,
        total_time_ms: totalTime,
        wallet_creation_time_ms: walletCreationTime,
        db_insert_time_ms: dbInsertTime,
        notification_time_ms: notificationTime,
        response_data: response
      });

      res.json(response);

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

      // Get live SOL balance
      const balanceData = await walletService.getSolBalance(user.in_app_public_key);
      const currentBalance = balanceData.balanceSol;

      // Validate balance requirements
      const MIN_BALANCE = 0.1;
      const requiredAmount = bundler_balance; // 1 SOL per mother wallet
      
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
      const bundlerData = await bundlerModel.createBundlerWithMotherWallets(
        user_wallet_id,
        bundler_balance
      );

      // Fund mother wallets (1 SOL each)
      logger.info('Funding mother wallets', { count: bundlerData.allocated_mother_wallets.length });
      
      const fundingTransfers = bundlerData.allocated_mother_wallets.map(wallet => ({
        fromPublicKey: user.in_app_public_key,
        toPublicKey: wallet.public_key,
        amountSol: 1.0,
        privateKey: user.in_app_private_key,
        commitment: 'confirmed'
      }));

      const fundingResults = await solService.batchTransfer(fundingTransfers, `${requestId}-funding`);
      
      if (fundingResults.failed > 0) {
        logger.error('Some mother wallet funding failed', { 
          successful: fundingResults.successful,
          failed: fundingResults.failed
        });
        // Continue with partial success - reconciliation can handle this later
      }

      // Update user balance (with rate limiting)
      logger.info(`Rate limiting: waiting 300ms before user balance check`);
      await new Promise(resolve => setTimeout(resolve, 300));
      
      try {
        const newUserBalance = await walletService.getSolBalance(user.in_app_public_key);
        await userModel.updateSolBalance(user_wallet_id, newUserBalance.balanceSol);
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
          await new Promise(resolve => setTimeout(resolve, 300));
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
      
      for (const motherWallet of bundlerData.allocated_mother_wallets) {
        try {
          const childWallets = await walletModel.getChildWalletsByMother(motherWallet.id);
          
          if (childWallets.length === 0) {
            logger.warn('No child wallets found for mother wallet', { motherWalletId: motherWallet.id });
            continue;
          }

          // Generate random distribution (ALL 4 child wallets get 0.2-0.3 SOL each, sum = 0.99 SOL to leave some for fees)
          const distributions = OrchestratorController.generateRandomDistribution(childWallets.length, 0.99);
          
          const childTransfers = [];
          for (let i = 0; i < childWallets.length; i++) {
            // All child wallets now receive funds (no need to check > 0)
            childTransfers.push({
              fromPublicKey: motherWallet.public_key,
              toPublicKey: childWallets[i].public_key,
              amountSol: distributions[i],
              privateKey: motherWallet.private_key,
              commitment: 'confirmed'
            });
          }

          if (childTransfers.length > 0) {
            const childResults = await solService.batchTransfer(
              childTransfers, 
              `${requestId}-child-${motherWallet.id}`
            );

            // Update child wallet balances with rate limiting
            for (let i = 0; i < childTransfers.length; i++) {
              const transfer = childTransfers[i];
              const result = childResults.results[i];
              
              if (result.success) {
                // Add delay between balance checks to respect API rate limits (4 req/s max)
                if (i > 0) {
                  logger.info(`Rate limiting: waiting 300ms before next balance check`);
                  await new Promise(resolve => setTimeout(resolve, 300)); // 300ms = ~3.3 req/s
                }
                
                try {
                  const childBalance = await walletService.getSolBalance(transfer.toPublicKey);
                  await walletModel.updateChildWalletSolBalance(
                    transfer.toPublicKey,
                    childBalance.balanceSol
                  );
                } catch (balanceError) {
                  logger.error('Failed to update child wallet balance after transfer', {
                    publicKey: transfer.toPublicKey,
                    error: balanceError.message
                  });
                  // Continue with other wallets even if one balance update fails
                }
              }
            }
          }

          // Update mother wallet balance after distributions (with rate limiting)
          logger.info(`Rate limiting: waiting 300ms before mother wallet balance check`);
          await new Promise(resolve => setTimeout(resolve, 300)); // Additional delay for mother wallet
          
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

      logger.info('Creating and buying token', { user_wallet_id, symbol, dev_buy_amount });

      // Get user and latest active bundler
      const user = await userModel.getUserByWalletId(user_wallet_id);
      if (!user) {
        throw new AppError('User not found', 404, 'USER_NOT_FOUND');
      }

      const bundler = await bundlerModel.getLatestActiveBundler(user_wallet_id);
      if (!bundler) {
        throw new AppError('No active bundler found', 404, 'NO_ACTIVE_BUNDLER');
      }

      // Upload logo to Pinata
      logger.info('Uploading token logo', { 
        logoSize: logo_base64?.length || 0,
        hasDataUri: logo_base64?.startsWith('data:') || false
      });
      
      const imageUrl = await uploadService.processAndUploadLogo(logo_base64, `${symbol.toLowerCase()}-logo`);

      // Create token on Pump.fun
      logger.info('Creating token on Pump.fun');
      const tokenCreationData = {
        creatorPublicKey: user.in_app_public_key,
        name,
        symbol,
        description,
        imageUrl,
        twitter: twitter || '',
        telegram: telegram || '',
        website: website || '',
        devBuyAmount: parseFloat(dev_buy_amount),
        slippageBps: Math.round(slippage * 100), // Convert percentage to basis points
        priorityFeeSol: priority_fee || 0.000005,
        privateKey: user.in_app_private_key,
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

      // Update user SOL and SPL balances from token creation
      if (creationBalances.solBalance > 0) {
        await userModel.updateSolBalance(user_wallet_id, creationBalances.solBalance);
      }
      if (creationBalances.splBalance > 0) {
        await userModel.updateSplBalance(user_wallet_id, creationBalances.splBalance);
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
               // Additional validation: if SPL balance is 0 but transaction was successful,
               // log this for investigation but still update the wallet
               if (balances.splBalance === 0 && result.data?.signature) {
                 logger.warn('Successful buy transaction but SPL balance is 0', {
                   walletPublicKey: wallet.public_key,
                   signature: result.data.signature,
                   solAmountSpent: buyOperations[i]?.solAmount,
                   postBalancesSpl: result.data?.postBalances?.spl,
                   note: 'This wallet may have received tokens that are not reflected in the API response'
                 });
                 
                 // Still update the wallet with the SOL balance change
                 // For SPL balance, we'll keep the existing balance since API shows 0
                 // but user confirmed they received tokens
                 const currentSplBalance = parseFloat(wallet.balance_spl) || 0;
                 await walletModel.updateChildWalletBalances(
                   wallet.public_key,
                   balances.solBalance,
                   currentSplBalance // Keep existing SPL balance if API returns 0
                 );
               } else {
                 // Normal case - update both balances
                 await walletModel.updateChildWalletBalances(
                   wallet.public_key,
                   balances.solBalance,
                   balances.splBalance
                 );
               }
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

         // Post-processing: Verify SPL balances for wallets that showed 0 but had successful transactions
         const walletsWithZeroSpl = [];
         for (let i = 0; i < buyResults.results.length; i++) {
           const result = buyResults.results[i];
           const wallet = buyableWallets[i];
           
           if (result.success && result.data?.signature) {
             const balances = ApiResponseValidator.extractTradeBalances(result.data);
             if (balances.splBalance === 0) {
               walletsWithZeroSpl.push({
                 publicKey: wallet.public_key,
                 signature: result.data.signature,
                 solAmountSpent: buyOperations[i]?.solAmount
               });
             }
           }
         }

         if (walletsWithZeroSpl.length > 0) {
           logger.warn('Found wallets with successful transactions but zero SPL balance in API response', {
             count: walletsWithZeroSpl.length,
             wallets: walletsWithZeroSpl,
             note: 'These wallets may have received tokens that are not reflected in the API response'
           });
           
           // TODO: Consider adding a blockchain balance verification step here
           // For now, we log this for monitoring and investigation
         }

         logger.info('Buy operations completed', {
           successful: buyResults.successful,
           failed: buyResults.failed,
           walletsWithZeroSplInResponse: walletsWithZeroSpl.length
         });
      }

      // Get final bundler state
      const finalBundler = await bundlerModel.getLatestActiveBundler(user_wallet_id);

      logger.info('Token creation and buying completed', {
        symbol,
        contractAddress,
        bundler_id: bundler.id
      });

      res.json({
        contract_address: contractAddress,
        token_name: symbol,
        bundler_id: bundler.id,
        total_balance_spl: finalBundler.total_balance_spl
      });
    } catch (error) {
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

      logger.info('Selling created token', { user_wallet_id, sell_percent });

      // Get user and latest active bundler
      const user = await userModel.getUserByWalletId(user_wallet_id);
      if (!user) {
        throw new AppError('User not found', 404, 'USER_NOT_FOUND');
      }

      const bundler = await bundlerModel.getLatestActiveBundler(user_wallet_id);
      if (!bundler) {
        throw new AppError('No active bundler found', 404, 'NO_ACTIVE_BUNDLER');
      }

      if (!bundler.token_name) {
        throw new AppError('No token associated with bundler', 400, 'NO_TOKEN_FOUND');
      }

      // Get token info
      const token = await tokenModel.getLatestTokenByUser(user_wallet_id);
      if (!token) {
        throw new AppError('No token found for user', 404, 'TOKEN_NOT_FOUND');
      }

      // Get child wallets with SPL balances
      const bundlerWithWallets = await bundlerModel.getBundlerWithWallets(bundler.id);
      const childWallets = [];
      
      for (const motherWallet of bundlerWithWallets.mother_wallets) {
        childWallets.push(...motherWallet.child_wallets);
      }

      // Include ALL child wallets in sell operations (even those with 0 balance)
      // This ensures consistent percentage application across all wallets
      const sellableWallets = childWallets.filter(wallet => {
        const splBalance = parseFloat(wallet.balance_spl);
        return splBalance >= 0; // Include all wallets, even with 0 balance
      });

      // Log detailed wallet information for debugging
      logger.info('Child wallet SPL balances for sell operation', {
        totalChildWallets: childWallets.length,
        sellableWallets: sellableWallets.length,
        walletBalances: childWallets.map(wallet => ({
          publicKey: wallet.public_key,
          splBalance: parseFloat(wallet.balance_spl),
          solBalance: parseFloat(wallet.balance_sol),
          willParticipateInSell: parseFloat(wallet.balance_spl) > 0
        }))
      });

      // Check if there are any tokens to sell across all wallets
      const totalSplBalance = childWallets.reduce((sum, wallet) => 
        sum + parseFloat(wallet.balance_spl), 0
      );

      if (totalSplBalance === 0) {
        throw new AppError('No tokens to sell across all child wallets', 400, 'NO_TOKENS_TO_SELL');
      }

      // Execute sell operations for ALL child wallets
      // The API will handle 0% of 0 tokens gracefully
      logger.info('Executing sell operations', { 
        walletCount: sellableWallets.length,
        totalSplBalance: totalSplBalance,
        sellPercent: sell_percent,
        expectedSellAmount: (totalSplBalance * sell_percent / 100).toFixed(6)
      });

      const sellOperations = sellableWallets.map(wallet => {
        const splBalance = parseFloat(wallet.balance_spl);
        
        return {
          sellerPublicKey: wallet.public_key,
          mintAddress: token.contract_address,
          tokenAmount: `${sell_percent}%`, // API accepts percentage format
          slippageBps: 100, // 1% slippage for sells
          privateKey: wallet.private_key,
          commitment: 'confirmed',
          // Add balance info for logging
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

      // Update child wallet balances from sell results
      for (let i = 0; i < sellResults.results.length; i++) {
        const result = sellResults.results[i];
        const wallet = sellableWallets[i];
        
        if (result.success && result.data) {
          const balances = ApiResponseValidator.extractTradeBalances(result.data);
          if (balances.publicKey) {
            await walletModel.updateChildWalletBalances(
              wallet.public_key,
              balances.solBalance,
              balances.splBalance
            );
          }
        }
      }

      // If 100% sell, transfer all SOL back and deactivate bundler
      if (sell_percent === 100) {
        logger.info('100% sell - transferring SOL back and deactivating bundler');

        // Get updated child wallets after sell
        const updatedChildWallets = await bundlerModel.getChildWallets(bundler.id);
        
        // Calculate proper rent exemption (account rent + transaction fees)
        const RENT_EXEMPTION = 0.00203928; // ~2.04 mSOL for account rent exemption
        const TRANSACTION_FEE = 0.000005; // 5 microSOL for transaction fee
        const MINIMUM_RESERVE = RENT_EXEMPTION + TRANSACTION_FEE; // ~0.002044 SOL total
        
        const walletsWithSol = updatedChildWallets.filter(wallet => {
          const balance = parseFloat(wallet.balance_sol);
          const transferableAmount = balance - MINIMUM_RESERVE;
          return transferableAmount > 0.0001; // Only transfer if meaningful amount after reserves
        });

        if (walletsWithSol.length > 0) {
          // Transfer all available SOL back to in-app wallet (keeping proper reserves)
          const transferBackOperations = walletsWithSol.map(wallet => {
            const balance = parseFloat(wallet.balance_sol);
            const transferAmount = Math.max(balance - MINIMUM_RESERVE, 0);
            
            logger.info('Preparing SOL transfer back', {
              wallet: wallet.public_key,
              totalBalance: balance,
              reserveAmount: MINIMUM_RESERVE,
              transferAmount: transferAmount
            });
            
            return {
              fromPublicKey: wallet.public_key,
              toPublicKey: user.in_app_public_key,
              amountSol: transferAmount,
              privateKey: wallet.private_key,
              commitment: 'confirmed'
            };
          });

          const transferResults = await solService.batchTransfer(
            transferBackOperations,
            `return-sol-${bundler.id}`,
            2000 // 2 second delay between transfers to avoid rate limits
          );

          logger.info('SOL transfer back completed', {
            successful: transferResults.successful,
            failed: transferResults.failed,
            totalOperations: transferBackOperations.length
          });

          // Log failed transfers for debugging
          if (transferResults.failed > 0) {
            logger.warn('Some SOL transfers failed during 100% sell cleanup', {
              failedCount: transferResults.failed,
              errors: transferResults.errors
            });
          }

          // Update balances
          const newUserBalance = await walletService.getSolBalance(user.in_app_public_key);
          await userModel.updateSolBalance(user_wallet_id, newUserBalance.balanceSol);
        }

        // Deactivate bundler
        await bundlerModel.deactivateBundler(bundler.id);
      }

      // Get final bundler state
      const finalBundler = await bundlerModel.getLatestActiveBundler(user_wallet_id);
      const remainingSpl = finalBundler ? finalBundler.total_balance_spl : "0";

      logger.info('Token sell completed', {
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

      if (!user.in_app_public_key) {
        throw new AppError('User does not have an in-app wallet', 400, 'NO_IN_APP_WALLET');
      }

      // Get current balance from blockchain API
      logger.info('Fetching balance from blockchain API', { 
        in_app_public_key: user.in_app_public_key 
      });

      const balanceData = await walletService.getSolBalance(user.in_app_public_key);
      const currentBalance = balanceData.balanceSol;

      // Update balance in database
      await userModel.updateSolBalance(user_wallet_id, currentBalance);

      logger.info('In-app SOL balance verified and updated', {
        user_wallet_id,
        previous_balance: user.balance_sol,
        current_balance: currentBalance,
        in_app_public_key: user.in_app_public_key
      });

      res.json({
        user_wallet_id,
        in_app_public_key: user.in_app_public_key,
        previous_balance_sol: user.balance_sol,
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

      // Get current in-app wallet balance
      const balanceData = await walletService.getSolBalance(user.in_app_public_key);
      const currentBalance = balanceData.balanceSol;

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
        fromPublicKey: user.in_app_public_key,
        toPublicKey: user_wallet_id,
        amountSol: transferAmount,
        privateKey: user.in_app_private_key,
        commitment: 'confirmed'
      }, `transfer-to-owner-${user_wallet_id}-${Date.now()}`);

      // Update user balance
      const newBalance = await walletService.getSolBalance(user.in_app_public_key);
      await userModel.updateSolBalance(user_wallet_id, newBalance.balanceSol);

      logger.info('Transfer to owner wallet completed', {
        user_wallet_id,
        amount_sol: transferAmount,
        txid: transferResult.signature,
        new_balance: newBalance.balanceSol
      });

      res.json({
        txid: transferResult.signature,
        new_balance_sol: newBalance.balanceSol.toString()
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Generate random distribution for child wallets - distribute to ALL child wallets
   * Each wallet must receive between 0.2 and 0.3 SOL, with total sum equal to totalAmount
   * @param {number} walletCount - Number of child wallets (should be 4)
   * @param {number} totalAmount - Total amount to distribute (should be ~0.99 SOL)
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
}

module.exports = new OrchestratorController();
