const rawApiClient = require('./rawApiClient');
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
        api_url: process.env.EXTERNAL_API_BASE_URL || 'https://rawapisolana-render.onrender.com',
        endpoint: '/api/v1/wallet/create'
      });

      const responseData = await rawApiClient.createWalletInRawApi({ count });
      const requestTime = Date.now() - requestStart;

      logger.info('✅ [WALLET_SERVICE] Blockchain API response received', {
        count,
        request_time_ms: requestTime,
        response_ok: responseData?.ok,
        data_length: Array.isArray(responseData?.data) ? responseData.data.length : 0
      });

      if (!ApiResponseValidator.validateWalletCreateResponse(responseData)) {
        logger.error('❌ [WALLET_SERVICE] Invalid response format from blockchain API', {
          count,
          request_time_ms: requestTime,
          response_structure: {
            has_ok: responseData ? 'ok' in responseData : false,
            has_data: responseData ? 'data' in responseData : false,
            data_is_array: Array.isArray(responseData?.data),
            data_length: Array.isArray(responseData?.data) ? responseData.data.length : 0
          }
        });
        throw new AppError('Invalid wallet creation response format', 502, 'WALLET_CREATION_INVALID_RESPONSE');
      }

      // Log wallet creation details (without exposing private keys)
      const wallets = responseData.data.map((wallet, index) => ({
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

      return responseData.data;
    } catch (error) {
      const requestTime = Date.now() - requestStart;
      
      logger.error('❌ [WALLET_SERVICE] Wallet creation failed', {
        count,
        request_time_ms: requestTime,
        error_message: error.message,
        error_code: error.code,
        api_url: process.env.EXTERNAL_API_BASE_URL || 'https://rawapisolana-render.onrender.com',
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
   * Get SOL balance for a wallet with automatic retry on rate limits
   * @param {string} publicKey - Wallet public key
   * @param {Object} options - Options for retry behavior
   * @param {number} options.maxRetries - Maximum number of retries (default: 3)
   * @param {boolean} options.logProgress - Whether to log retry progress (default: true)
   * @returns {Promise<Object>} Balance information
   */
  async getSolBalance(publicKey, options = {}) {
    const { maxRetries = 3, logProgress = true } = options;
    let lastError;

    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
      try {
        if (logProgress) {
          logger.info('Getting SOL balance', { 
            publicKey, 
            attempt: attempt > 1 ? `${attempt}/${maxRetries + 1}` : undefined 
          });
        }

        const response = await apiClient.get(`/api/v1/wallet/${publicKey}/balance/sol`);

        if (!ApiResponseValidator.validateSolBalanceResponse(response)) {
          throw new AppError('Invalid balance response format', 502, 'BALANCE_INVALID_RESPONSE');
        }

        // Success - log if this was a retry
        if (attempt > 1 && logProgress) {
          logger.info('SOL balance retrieved successfully after retry', { 
            publicKey, 
            attempt,
            balance: response.data.balanceSol
          });
        }

        return response.data;
      } catch (error) {
        lastError = error;
        
        // Handle 404 - wallet not found or has no balance (don't retry)
        if (error.response?.status === 404) {
          return {
            publicKey,
            balanceSol: 0,
            balanceLamports: '0'
          };
        }

        // Check if this is a rate limit error that we should handle locally
        const isRateLimit = this.isRateLimitError(error);
        const shouldRetryLocally = isRateLimit && attempt <= maxRetries;

        if (shouldRetryLocally) {
          const delay = Math.pow(2, attempt - 1) * 1000 + Math.random() * 500; // 1s, 2s, 4s + jitter
          
          if (logProgress) {
            logger.warn(`Rate limit hit getting SOL balance, retrying in ${delay}ms`, {
              publicKey,
              attempt,
              maxRetries: maxRetries + 1,
              error: error.response?.data?.error || error.message
            });
          }
          
          await this.sleep(delay);
          continue; // Retry the loop
        }

        // If we're here, either it's not a rate limit error or we've exhausted retries
        break;
      }
    }

    // All retries exhausted or non-retryable error
    logger.error('Error getting SOL balance after all retries:', { 
      publicKey, 
      attempts: maxRetries + 1,
      error: lastError.message 
    });
    
    if (lastError instanceof AppError) {
      throw lastError;
    }
    
    throw new AppError(
      'Failed to get balance from external API after retries',
      502,
      'EXTERNAL_BALANCE_API_ERROR'
    );
  }

  /**
   * Check if error is a rate limit error
   * @param {Error} error - The error to check
   * @returns {boolean} True if it's a rate limit error
   */
  isRateLimitError(error) {
    const status = error.response?.status;
    const errorMessage = error.response?.data?.error || error.message || '';
    
    return (
      status === 400 && (
        errorMessage.includes('Rate limit exceeded') ||
        errorMessage.includes('rate limit') ||
        errorMessage.includes('too many requests') ||
        errorMessage.includes('max 4 req/s')
      )
    ) || status === 429;
  }

  /**
   * Sleep utility function
   * @param {number} ms - Milliseconds to sleep
   * @returns {Promise} Promise that resolves after the delay
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
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

  /**
   * Get SPL token balance for a wallet
   * @param {string} mintAddress - Token contract address
   * @param {string} walletPublicKey - Wallet public key
   * @param {Object} options - Options for retry behavior
   * @param {number} options.maxRetries - Maximum number of retries (default: 3)
   * @param {boolean} options.logProgress - Whether to log retry progress (default: true)
   * @returns {Promise<Object>} SPL balance information
   */
  async getSplBalance(mintAddress, walletPublicKey, options = {}) {
    const { maxRetries = 3, logProgress = true } = options;
    const requestStart = Date.now();
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        if (logProgress) {
          logger.info('🔗 [WALLET_SERVICE] Getting SPL token balance', {
            mintAddress,
            walletPublicKey,
            attempt,
            maxRetries,
            api_url: process.env.EXTERNAL_API_BASE_URL || 'https://rawapisolana-render.onrender.com',
            endpoint: `/api/v1/spl/${mintAddress}/balance/${walletPublicKey}`
          });
        }

        const response = await apiClient.get(`/api/v1/spl/${mintAddress}/balance/${walletPublicKey}`);
        const requestTime = Date.now() - requestStart;

        if (logProgress) {
          logger.info('✅ [WALLET_SERVICE] SPL balance retrieved successfully', {
            mintAddress,
            walletPublicKey,
            request_time_ms: requestTime,
            attempt,
            balance_data: response.data
          });
        }

        // Validate response structure
        if (!response.ok || !response.data) {
          throw new AppError('Invalid SPL balance response format', 502, 'SPL_BALANCE_INVALID_RESPONSE');
        }

        return {
          mintAddress,
          walletPublicKey,
          balance: response.data.balance || 0,
          uiAmount: response.data.uiAmount || 0,
          rawAmount: response.data.rawAmount || '0',
          decimals: response.data.decimals || 6
        };

      } catch (error) {
        const requestTime = Date.now() - requestStart;
        const isLastAttempt = attempt === maxRetries;
        
        // Check if it's a rate limit error
        const isRateLimit = error.response?.status === 429 || 
                           error.message?.includes('rate limit') ||
                           error.message?.includes('Too Many Requests');

        if (logProgress) {
          logger.warn(`⚠️ [WALLET_SERVICE] SPL balance request failed (attempt ${attempt}/${maxRetries})`, {
            mintAddress,
            walletPublicKey,
            request_time_ms: requestTime,
            error_message: error.message,
            error_code: error.code,
            http_status: error.response?.status,
            is_rate_limit: isRateLimit,
            is_last_attempt: isLastAttempt
          });
        }

        if (isLastAttempt) {
          logger.error('❌ [WALLET_SERVICE] SPL balance retrieval failed after all retries', {
            mintAddress,
            walletPublicKey,
            request_time_ms: requestTime,
            total_attempts: maxRetries,
            final_error: error.message
          });

          if (error instanceof AppError) {
            throw error;
          }

          // Enhance error context
          let errorCode = 'EXTERNAL_SPL_BALANCE_ERROR';
          let errorMessage = 'Failed to get SPL balance from blockchain API';

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

        // Wait before retry (exponential backoff for rate limits, linear for others)
        const delay = isRateLimit ? Math.pow(2, attempt) * 1000 : attempt * 1000;
        if (logProgress) {
          logger.info(`⏳ [WALLET_SERVICE] Waiting ${delay}ms before retry`, {
            mintAddress,
            walletPublicKey,
            attempt,
            delay_ms: delay,
            reason: isRateLimit ? 'rate_limit' : 'generic_error'
          });
        }
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
}

module.exports = new WalletService();
