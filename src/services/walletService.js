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
    const requestStart = Date.now();
    
    try {
      logger.info('🔗 [WALLET_SERVICE] Initiating wallet creation request', {
        count,
        api_url: process.env.EXTERNAL_API_BASE_URL || 'https://rawapisolana-render.onrender.com:10000',
        endpoint: '/wallet/create'
      });

      const response = await apiClient.post('/wallet/create', { count });
      const requestTime = Date.now() - requestStart;

      logger.info('✅ [WALLET_SERVICE] Blockchain API response received', {
        count,
        request_time_ms: requestTime,
        response_ok: response.ok,
        data_length: response.data ? response.data.length : 0
      });

      if (!ApiResponseValidator.validateWalletCreateResponse(response)) {
        logger.error('❌ [WALLET_SERVICE] Invalid response format from blockchain API', {
          count,
          request_time_ms: requestTime,
          response_structure: {
            has_ok: 'ok' in response,
            has_data: 'data' in response,
            data_is_array: Array.isArray(response.data),
            data_length: response.data ? response.data.length : 0
          }
        });
        throw new AppError('Invalid wallet creation response format', 502, 'WALLET_CREATION_INVALID_RESPONSE');
      }

      // Log wallet creation details (without exposing private keys)
      const wallets = response.data.map((wallet, index) => ({
        index,
        has_public_key: !!wallet.publicKey,
        has_private_key: !!wallet.privateKey,
        public_key_length: wallet.publicKey ? wallet.publicKey.length : 0,
        private_key_length: wallet.privateKey ? wallet.privateKey.length : 0
      }));

      logger.info('✅ [WALLET_SERVICE] Wallet creation successful', {
        count,
        request_time_ms: requestTime,
        wallets_created: wallets.length,
        wallet_details: wallets
      });

      return response.data;
    } catch (error) {
      const requestTime = Date.now() - requestStart;
      
      logger.error('❌ [WALLET_SERVICE] Wallet creation failed', {
        count,
        request_time_ms: requestTime,
        error_message: error.message,
        error_code: error.code,
        api_url: process.env.EXTERNAL_API_BASE_URL || 'https://rawapisolana-render.onrender.com:10000',
        is_network_error: !error.response,
        http_status: error.response?.status,
        response_data: error.response?.data
      });
      
      if (error instanceof AppError) {
        throw error;
      }
      
      // Enhance error context based on error type
      let errorCode = 'EXTERNAL_WALLET_API_ERROR';
      let errorMessage = 'Failed to create wallet from external API';

      if (!error.response) {
        errorCode = 'NETWORK_ERROR';
        errorMessage = 'Network error while connecting to blockchain API';
      } else if (error.response.status >= 500) {
        errorCode = 'BLOCKCHAIN_API_SERVER_ERROR';
        errorMessage = 'Blockchain API server error';
      } else if (error.response.status === 429) {
        errorCode = 'RATE_LIMITED';
        errorMessage = 'Rate limited by blockchain API';
      }

      throw new AppError(errorMessage, 502, errorCode);
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
