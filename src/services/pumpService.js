const apiClient = require('./apiClient');
const logger = require('../utils/logger');
const { AppError } = require('../middleware/errorHandler');
const ApiResponseValidator = require('../utils/apiResponseValidator');

class PumpService {
  /**
   * Create a token on Pump.fun
   * @param {Object} tokenData - Token creation parameters
   * @returns {Promise<Object>} Creation result with contract address and balances
   */
  async createToken(tokenData) {
    try {
      logger.info('Creating token on Pump.fun', {
        name: tokenData.name,
        symbol: tokenData.symbol,
        devBuyAmount: tokenData.devBuyAmount
      });

      const response = await apiClient.post('/api/v1/pump/advanced-create', tokenData);

      if (!ApiResponseValidator.validatePumpCreateResponse(response)) {
        throw new AppError('Invalid token creation response format', 502, 'TOKEN_CREATION_INVALID_RESPONSE');
      }

      logger.info('Token created successfully', {
        signature: response.data.signature,
        confirmed: response.data.confirmed
      });

      return response.data;
    } catch (error) {
      logger.error('Error creating token:', {
        symbol: tokenData.symbol,
        error: error.message
      });
      
      if (error instanceof AppError) {
        throw error;
      }
      
      throw new AppError(
        'Failed to create token via Pump.fun API',
        502,
        'EXTERNAL_PUMP_CREATE_ERROR'
      );
    }
  }

  /**
   * Buy tokens via Pump.fun
   * @param {Object} buyData - Buy parameters
   * @param {string} buyData.buyerPublicKey - Buyer's public key
   * @param {string} buyData.mintAddress - Token contract address
   * @param {number} buyData.solAmount - Amount of SOL to spend
   * @param {number} buyData.slippageBps - Slippage in basis points
   * @param {string} buyData.privateKey - Buyer's private key
   * @param {number} [buyData.priorityFeeSol] - Priority fee in SOL
   * @param {string} [buyData.commitment] - Confirmation level
   * @returns {Promise<Object>} Buy result with balances
   */
  async buy(buyData) {
    try {
      logger.info('Buying tokens on Pump.fun', {
        buyer: buyData.buyerPublicKey,
        mintAddress: buyData.mintAddress,
        solAmount: buyData.solAmount,
        slippage: buyData.slippageBps
      });

      const response = await apiClient.post('/api/v1/pump/advanced-buy', buyData);

      if (!ApiResponseValidator.validatePumpTradeResponse(response)) {
        throw new AppError('Invalid token buy response format', 502, 'TOKEN_BUY_INVALID_RESPONSE');
      }

      logger.info('Token buy completed', {
        signature: response.data.signature,
        confirmed: response.data.confirmed
      });

      return response.data;
    } catch (error) {
      logger.error('Error buying tokens:', {
        buyer: buyData.buyerPublicKey,
        mintAddress: buyData.mintAddress,
        error: error.message
      });
      
      if (error instanceof AppError) {
        throw error;
      }
      
      throw new AppError(
        'Failed to buy tokens via Pump.fun API',
        502,
        'EXTERNAL_PUMP_BUY_ERROR'
      );
    }
  }

  /**
   * Sell tokens via Pump.fun
   * @param {Object} sellData - Sell parameters
   * @param {string} sellData.sellerPublicKey - Seller's public key
   * @param {string} sellData.mintAddress - Token contract address
   * @param {string} sellData.tokenAmount - Amount to sell (percentage or numeric)
   * @param {number} sellData.slippageBps - Slippage in basis points
   * @param {string} sellData.privateKey - Seller's private key
   * @param {number} [sellData.priorityFeeSol] - Priority fee in SOL
   * @param {string} [sellData.commitment] - Confirmation level
   * @returns {Promise<Object>} Sell result with balances
   */
  async sell(sellData) {
    try {
      logger.info('Selling tokens on Pump.fun', {
        seller: sellData.sellerPublicKey,
        mintAddress: sellData.mintAddress,
        tokenAmount: sellData.tokenAmount,
        slippage: sellData.slippageBps
      });

      const response = await apiClient.post('/api/v1/pump/advanced-sell', sellData);

      if (!ApiResponseValidator.validatePumpTradeResponse(response)) {
        throw new AppError('Invalid token sell response format', 502, 'TOKEN_SELL_INVALID_RESPONSE');
      }

      logger.info('Token sell completed', {
        signature: response.data.signature,
        confirmed: response.data.confirmed
      });

      return response.data;
    } catch (error) {
      logger.error('Error selling tokens:', {
        seller: sellData.sellerPublicKey,
        mintAddress: sellData.mintAddress,
        error: error.message
      });
      
      if (error instanceof AppError) {
        throw error;
      }
      
      throw new AppError(
        'Failed to sell tokens via Pump.fun API',
        502,
        'EXTERNAL_PUMP_SELL_ERROR'
      );
    }
  }

  /**
   * Execute multiple buy operations for bundler wallets with rate limiting
   * @param {Array} buyOperations - Array of buy operation objects
   * @param {string} [idempotencyKey] - Base idempotency key
   * @returns {Promise<Object>} Batch buy results
   */
  async batchBuy(buyOperations, idempotencyKey = null) {
    const results = [];
    const errors = [];

    logger.info('Executing batch buy operations with rate limiting', { count: buyOperations.length });

    for (let i = 0; i < buyOperations.length; i++) {
      try {
        const config = idempotencyKey ? { idempotencyKey: `${idempotencyKey}-buy-${i}` } : {};
        
        // Add delay between requests to respect rate limits (1 req/s)
        if (i > 0) {
          const delay = 1200; // 1.2 seconds to be safe
          logger.info(`Rate limiting: waiting ${delay}ms before next buy operation`, { operationIndex: i });
          await this.sleep(delay);
        }
        
        const result = await this.buyWithRetry(buyOperations[i], 3);
        results.push({ index: i, success: true, data: result });
        
        logger.info(`Buy operation ${i + 1}/${buyOperations.length} completed successfully`, {
          buyer: buyOperations[i].buyerPublicKey,
          solAmount: buyOperations[i].solAmount
        });
        
      } catch (error) {
        logger.error(`Batch buy operation ${i} failed after retries:`, {
          buyer: buyOperations[i].buyerPublicKey,
          error: error.message,
          code: error.code
        });
        errors.push({ index: i, error: error.message });
        results.push({ index: i, success: false, error: error.message });
      }
    }

    return {
      results,
      successful: results.filter(r => r.success).length,
      failed: errors.length,
      errors
    };
  }

  /**
   * Buy tokens with retry mechanism for rate limiting
   * @param {Object} buyData - Buy parameters
   * @param {number} maxRetries - Maximum number of retries
   * @returns {Promise<Object>} Buy result
   */
  async buyWithRetry(buyData, maxRetries = 3) {
    let lastError = null;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await this.buy(buyData);
      } catch (error) {
        lastError = error;
        
        // Check if it's a rate limit error
        const isRateLimit = error.message?.includes('Rate limit exceeded') || 
                           error.message?.includes('rate limit') ||
                           (error.statusCode === 400 && error.message?.includes('max 1 req/s'));
        
        // Check if it's an insufficient balance error
        const isInsufficientBalance = error.message?.includes('insufficient lamports') ||
                                    error.message?.includes('Transfer: insufficient');
        
        if (isInsufficientBalance) {
          logger.error('Insufficient balance detected, not retrying', {
            buyer: buyData.buyerPublicKey,
            solAmount: buyData.solAmount,
            error: error.message
          });
          throw error; // Don't retry insufficient balance errors
        }
        
        if (isRateLimit && attempt < maxRetries) {
          const backoffDelay = Math.min(1000 * Math.pow(2, attempt), 10000); // Exponential backoff, max 10s
          logger.warn(`Rate limit hit, retrying in ${backoffDelay}ms`, {
            attempt,
            maxRetries,
            buyer: buyData.buyerPublicKey
          });
          await this.sleep(backoffDelay);
          continue;
        }
        
        if (attempt < maxRetries) {
          const retryDelay = 2000 * attempt; // Linear backoff for other errors
          logger.warn(`Buy attempt ${attempt} failed, retrying in ${retryDelay}ms`, {
            buyer: buyData.buyerPublicKey,
            error: error.message
          });
          await this.sleep(retryDelay);
          continue;
        }
        
        // If we've exhausted all retries, throw the last error
        throw error;
      }
    }
    
    throw lastError;
  }

  /**
   * Sleep utility function
   * @param {number} ms - Milliseconds to sleep
   * @returns {Promise<void>}
   */
  async sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Execute multiple sell operations for bundler wallets
   * @param {Array} sellOperations - Array of sell operation objects
   * @param {string} [idempotencyKey] - Base idempotency key
   * @returns {Promise<Object>} Batch sell results
   */
  async batchSell(sellOperations, idempotencyKey = null) {
    const results = [];
    const errors = [];

    logger.info('Executing batch sell operations', { count: sellOperations.length });

    for (let i = 0; i < sellOperations.length; i++) {
      try {
        const config = idempotencyKey ? { idempotencyKey: `${idempotencyKey}-sell-${i}` } : {};
        const result = await this.sell(sellOperations[i]);
        results.push({ index: i, success: true, data: result });
      } catch (error) {
        logger.error(`Batch sell operation ${i} failed:`, error);
        errors.push({ index: i, error: error.message });
        results.push({ index: i, success: false, error: error.message });
      }
    }

    return {
      results,
      successful: results.filter(r => r.success).length,
      failed: errors.length,
      errors
    };
  }
}

module.exports = new PumpService();
