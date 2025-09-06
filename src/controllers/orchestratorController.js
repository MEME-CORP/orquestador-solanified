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

      // Update user balance
      const newUserBalance = await walletService.getSolBalance(user.in_app_public_key);
      await userModel.updateSolBalance(user_wallet_id, newUserBalance.balanceSol);

      // Update mother wallet balances
      for (const wallet of bundlerData.allocated_mother_wallets) {
        const motherBalance = await walletService.getSolBalance(wallet.public_key);
        await walletModel.updateMotherWalletBalance(wallet.id, motherBalance.balanceSol);
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

          // Generate random distribution (ALL 4 child wallets get funds, sum = 0.99 SOL to leave some for fees)
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

            // Update child wallet balances
            for (let i = 0; i < childTransfers.length; i++) {
              const transfer = childTransfers[i];
              const result = childResults.results[i];
              
              if (result.success) {
                const childBalance = await walletService.getSolBalance(transfer.toPublicKey);
                await walletModel.updateChildWalletSolBalance(
                  transfer.toPublicKey,
                  childBalance.balanceSol
                );
              }
            }
          }

          // Update mother wallet balance after distributions
          const updatedMotherBalance = await walletService.getSolBalance(motherWallet.public_key);
          await walletModel.updateMotherWalletBalance(motherWallet.id, updatedMotherBalance.balanceSol);

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
      logger.info('Uploading token logo');
      const imageUrl = await uploadService.processAndUploadLogo(logo_base64, `${symbol.toLowerCase()}-logo.png`);

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

      // Update user SOL and SPL balances from token creation
      if (tokenResult.postBalances?.sol?.balanceSol) {
        await userModel.updateSolBalance(user_wallet_id, tokenResult.postBalances.sol.balanceSol);
      }
      if (tokenResult.postBalances?.spl?.uiAmount) {
        await userModel.updateSplBalance(user_wallet_id, tokenResult.postBalances.spl.uiAmount);
      }

      // Get child wallets for buying
      const bundlerWithWallets = await bundlerModel.getBundlerWithWallets(bundler.id);
      const childWallets = [];
      
      for (const motherWallet of bundlerWithWallets.mother_wallets) {
        childWallets.push(...motherWallet.child_wallets);
      }

      // Filter child wallets with sufficient SOL balance for buying
      const MIN_BUY_AMOUNT = 0.001;
      const buyableWallets = childWallets.filter(wallet => 
        parseFloat(wallet.balance_sol) >= MIN_BUY_AMOUNT
      );

      if (buyableWallets.length === 0) {
        logger.warn('No child wallets have sufficient balance for buying');
      } else {
        // Execute buy operations
        logger.info('Executing buy operations', { walletCount: buyableWallets.length });
        
        const buyOperations = buyableWallets.map(wallet => ({
          buyerPublicKey: wallet.public_key,
          mintAddress: contractAddress,
          solAmount: Math.max(parseFloat(wallet.balance_sol) - 0.0002, MIN_BUY_AMOUNT), // Leave some for fees
          slippageBps: Math.round(slippage * 100),
          priorityFeeSol: priority_fee || 0.000005,
          privateKey: wallet.private_key,
          commitment: 'confirmed'
        }));

        const buyResults = await pumpService.batchBuy(buyOperations, `token-buy-${bundler.id}`);

        // Update child wallet balances from buy results
        for (let i = 0; i < buyResults.results.length; i++) {
          const result = buyResults.results[i];
          const wallet = buyableWallets[i];
          
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

        logger.info('Buy operations completed', {
          successful: buyResults.successful,
          failed: buyResults.failed
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

      // Filter wallets with SPL tokens to sell
      const sellableWallets = childWallets.filter(wallet => 
        parseFloat(wallet.balance_spl) > 0
      );

      if (sellableWallets.length === 0) {
        throw new AppError('No tokens to sell', 400, 'NO_TOKENS_TO_SELL');
      }

      // Execute sell operations
      logger.info('Executing sell operations', { 
        walletCount: sellableWallets.length,
        sellPercent: sell_percent
      });

      const sellOperations = sellableWallets.map(wallet => ({
        sellerPublicKey: wallet.public_key,
        mintAddress: token.contract_address,
        tokenAmount: `${sell_percent}%`, // API accepts percentage format
        slippageBps: 100, // 1% slippage for sells
        privateKey: wallet.private_key,
        commitment: 'confirmed'
      }));

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
        const walletsWithSol = updatedChildWallets.filter(wallet => 
          parseFloat(wallet.balance_sol) > 0.0001 // Only transfer if meaningful amount
        );

        if (walletsWithSol.length > 0) {
          // Transfer all SOL back to in-app wallet
          const transferBackOperations = walletsWithSol.map(wallet => ({
            fromPublicKey: wallet.public_key,
            toPublicKey: user.in_app_public_key,
            amountSol: Math.max(parseFloat(wallet.balance_sol) - 0.000005, 0), // Leave tiny amount for rent
            privateKey: wallet.private_key,
            commitment: 'confirmed'
          }));

          const transferResults = await solService.batchTransfer(
            transferBackOperations,
            `return-sol-${bundler.id}`
          );

          logger.info('SOL transfer back completed', {
            successful: transferResults.successful,
            failed: transferResults.failed
          });

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
   * @param {number} walletCount - Number of child wallets (should be 4)
   * @param {number} totalAmount - Total amount to distribute
   * @returns {Array<number>} Array of amounts for each wallet
   */
  static generateRandomDistribution(walletCount, totalAmount) {
    const distributions = new Array(walletCount).fill(0);
    
    // Distribute to ALL child wallets (not just 2-3)
    // Generate random weights for all wallets
    const weights = [];
    for (let i = 0; i < walletCount; i++) {
      weights.push(Math.random());
    }
    
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);

    // Distribute amounts based on weights to ALL wallets
    for (let i = 0; i < walletCount; i++) {
      distributions[i] = (weights[i] / totalWeight) * totalAmount;
    }

    logger.info('Generated distribution for child wallets', {
      walletCount,
      totalAmount,
      distributions: distributions.map((amount, index) => ({ 
        wallet: index, 
        amount: amount.toFixed(9) 
      }))
    });

    return distributions;
  }
}

module.exports = new OrchestratorController();
