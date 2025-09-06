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
   * Execute multiple buy operations for bundler wallets
   * @param {Array} buyOperations - Array of buy operation objects
   * @param {string} [idempotencyKey] - Base idempotency key
   * @returns {Promise<Object>} Batch buy results
   */
  async batchBuy(buyOperations, idempotencyKey = null) {
    const results = [];
    const errors = [];

    logger.info('Executing batch buy operations', { count: buyOperations.length });

    for (let i = 0; i < buyOperations.length; i++) {
      try {
        const config = idempotencyKey ? { idempotencyKey: `${idempotencyKey}-buy-${i}` } : {};
        const result = await this.buy(buyOperations[i]);
        results.push({ index: i, success: true, data: result });
      } catch (error) {
        logger.error(`Batch buy operation ${i} failed:`, error);
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
