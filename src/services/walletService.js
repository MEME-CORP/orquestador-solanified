const apiClient = require('./apiClient');
const logger = require('../utils/logger');
const { AppError } = require('../middleware/errorHandler');
const ApiResponseValidator = require('../utils/apiResponseValidator');

class WalletService {
  /**
   * Create a new Solana wallet
   * @param {number} count - Number of wallets to create (default: 1)
   * @returns {Promise<Array>} Array of wallet objects with publicKey and privateKey
   */
  async createInAppWallet(count = 1) {
    try {
      logger.info('Creating in-app wallet(s)', { count });

      const response = await apiClient.post('/wallet/create', { count });

      if (!ApiResponseValidator.validateWalletCreateResponse(response)) {
        throw new AppError('Invalid wallet creation response format', 502, 'WALLET_CREATION_INVALID_RESPONSE');
      }

      return response.data;
    } catch (error) {
      logger.error('Error creating in-app wallet:', error);
      
      if (error instanceof AppError) {
        throw error;
      }
      
      throw new AppError(
        'Failed to create wallet from external API',
        502,
        'EXTERNAL_WALLET_API_ERROR'
      );
    }
  }

  /**
   * Get SOL balance for a wallet
   * @param {string} publicKey - Wallet public key
   * @returns {Promise<Object>} Balance information
   */
  async getSolBalance(publicKey) {
    try {
      logger.info('Getting SOL balance', { publicKey });

      const response = await apiClient.get(`/wallet/${publicKey}/balance/sol`);

      if (!ApiResponseValidator.validateSolBalanceResponse(response)) {
        throw new AppError('Invalid balance response format', 502, 'BALANCE_INVALID_RESPONSE');
      }

      return response.data;
    } catch (error) {
      logger.error('Error getting SOL balance:', { publicKey, error: error.message });
      
      if (error instanceof AppError) {
        throw error;
      }
      
      // Handle 404 - wallet not found or has no balance
      if (error.response?.status === 404) {
        return {
          publicKey,
          balanceSol: 0,
          balanceLamports: '0'
        };
      }
      
      throw new AppError(
        'Failed to get balance from external API',
        502,
        'EXTERNAL_BALANCE_API_ERROR'
      );
    }
  }

  /**
   * Get multiple wallet balances in parallel
   * @param {Array<string>} publicKeys - Array of public keys
   * @returns {Promise<Array>} Array of balance objects
   */
  async getMultipleSolBalances(publicKeys) {
    try {
      logger.info('Getting multiple SOL balances', { count: publicKeys.length });

      const promises = publicKeys.map(publicKey => 
        this.getSolBalance(publicKey).catch(error => ({
          publicKey,
          error: error.message,
          balanceSol: 0,
          balanceLamports: '0'
        }))
      );

      const results = await Promise.all(promises);
      return results;
    } catch (error) {
      logger.error('Error getting multiple SOL balances:', error);
      throw new AppError(
        'Failed to get multiple balances',
        500,
        'MULTIPLE_BALANCE_FETCH_FAILED'
      );
    }
  }
}

module.exports = new WalletService();
