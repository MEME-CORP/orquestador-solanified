const apiClient = require('./apiClient');
const logger = require('../utils/logger');
const { AppError } = require('../middleware/errorHandler');
const ApiResponseValidator = require('../utils/apiResponseValidator');

class SolService {
  /**
   * Transfer SOL using advanced transfer endpoint with automatic retry
   * @param {Object} transferData - Transfer parameters
   * @param {string} transferData.fromPublicKey - Sender public key
   * @param {string} transferData.toPublicKey - Recipient public key
   * @param {number} transferData.amountSol - Amount in SOL
   * @param {string} transferData.privateKey - Sender private key
   * @param {number} [transferData.computeUnits] - Compute units limit
   * @param {number} [transferData.microLamports] - Micro-lamports per compute unit
   * @param {string} [transferData.commitment] - Confirmation level
   * @param {string} [idempotencyKey] - Idempotency key for retry safety
   * @param {Object} [options] - Retry options
   * @param {number} [options.maxRetries] - Maximum retries (default: 3)
   * @returns {Promise<Object>} Transfer result
   */
  async transfer(transferData, idempotencyKey = null, options = {}) {
    const { maxRetries = 3 } = options;
    
    // Validate minimum balance requirement (0.0001 SOL reserved)
    const MIN_RESERVE = 0.0001;
    if (transferData.amountSol < MIN_RESERVE) {
      throw new AppError(
        `Transfer amount must be at least ${MIN_RESERVE} SOL`,
        400,
        'AMOUNT_TOO_SMALL'
      );
    }

    let lastError;
    
    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
      try {
        logger.info('Initiating SOL transfer', {
          from: transferData.fromPublicKey,
          to: transferData.toPublicKey,
          amount: transferData.amountSol,
          idempotencyKey,
          attempt: attempt > 1 ? `${attempt}/${maxRetries + 1}` : undefined
        });

        const config = idempotencyKey ? { idempotencyKey } : {};
        const response = await apiClient.post('/api/v1/sol/advanced-transfer', transferData, config);

        if (!ApiResponseValidator.validateSolTransferResponse(response)) {
          throw new AppError('Invalid transfer response format', 502, 'TRANSFER_INVALID_RESPONSE');
        }

        // Success - log if this was a retry
        if (attempt > 1) {
          logger.info('SOL transfer completed successfully after retry', {
            signature: response.data.signature,
            confirmed: response.data.confirmed,
            attempt
          });
        } else {
          logger.info('SOL transfer completed', {
            signature: response.data.signature,
            confirmed: response.data.confirmed
          });
        }

        return response.data;
      } catch (error) {
        lastError = error;
        
        // Don't retry validation errors or insufficient balance errors
        if (error instanceof AppError && (
          error.code === 'AMOUNT_TOO_SMALL' ||
          error.code === 'TRANSFER_INVALID_RESPONSE' ||
          error.message.includes('Insufficient balance')
        )) {
          break;
        }

        // Check if this is a rate limit error and we should retry
        const isRateLimit = this.isRateLimitError(error);
        const shouldRetryLocally = (isRateLimit || error.response?.status >= 500) && attempt <= maxRetries;

        if (shouldRetryLocally) {
          const delay = Math.pow(2, attempt - 1) * 2000 + Math.random() * 1000; // 2s, 4s, 8s + jitter
          
          logger.warn(`Transfer failed, retrying in ${delay}ms`, {
            from: transferData.fromPublicKey,
            to: transferData.toPublicKey,
            attempt,
            maxRetries: maxRetries + 1,
            error: error.response?.data?.error || error.message,
            isRateLimit
          });
          
          await this.sleep(delay);
          continue;
        }

        // Non-retryable error or max retries reached
        break;
      }
    }

    // All retries exhausted
    logger.error('Error in SOL transfer after all retries:', {
      from: transferData.fromPublicKey,
      to: transferData.toPublicKey,
      attempts: maxRetries + 1,
      error: lastError.message
    });
    
    if (lastError instanceof AppError) {
      throw lastError;
    }
    
    throw new AppError(
      'Failed to execute SOL transfer after retries',
      502,
      'EXTERNAL_TRANSFER_API_ERROR'
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
   * Execute multiple transfers in sequence with error handling and rate limiting
   * @param {Array} transfers - Array of transfer objects
   * @param {string} [idempotencyKey] - Base idempotency key
   * @param {number} [rateLimitDelay] - Delay between transfers in ms (default: 1500ms for 1 req/s limit)
   * @returns {Promise<Array>} Array of transfer results
   */
  async batchTransfer(transfers, idempotencyKey = null, rateLimitDelay = 1500) {
    const results = [];
    const errors = [];

    for (let i = 0; i < transfers.length; i++) {
      try {
        // Add delay between transfers to respect rate limits (except for first transfer)
        if (i > 0 && rateLimitDelay > 0) {
          logger.info(`Rate limiting: waiting ${rateLimitDelay}ms before next transfer`);
          await new Promise(resolve => setTimeout(resolve, rateLimitDelay));
        }

        const transferKey = idempotencyKey ? `${idempotencyKey}-${i}` : null;
        const result = await this.transfer(transfers[i], transferKey);
        results.push({ index: i, success: true, data: result });
      } catch (error) {
        logger.error(`Batch transfer ${i} failed:`, error);
        errors.push({ index: i, error: error.message });
        results.push({ index: i, success: false, error: error.message });
        
        // Continue with remaining transfers even if one fails
        continue;
      }
    }

    if (errors.length > 0) {
      logger.warn('Some transfers in batch failed', { 
        total: transfers.length, 
        failed: errors.length 
      });
    }

    return {
      results,
      successful: results.filter(r => r.success).length,
      failed: errors.length,
      errors
    };
  }

  /**
   * Transfer SOL from one source to multiple destinations
   * @param {string} fromPublicKey - Source public key
   * @param {string} fromPrivateKey - Source private key
   * @param {Array} outputs - Array of {toPublicKey, amountSol} objects
   * @param {string} [idempotencyKey] - Idempotency key
   * @returns {Promise<Array>} Array of transfer results
   */
  async multiTransfer(fromPublicKey, fromPrivateKey, outputs, idempotencyKey = null) {
    try {
      logger.info('Initiating multi-transfer', {
        from: fromPublicKey,
        outputCount: outputs.length,
        totalAmount: outputs.reduce((sum, output) => sum + output.amountSol, 0)
      });

      const transfers = outputs.map(output => ({
        fromPublicKey,
        toPublicKey: output.toPublicKey,
        amountSol: output.amountSol,
        privateKey: fromPrivateKey,
        commitment: 'confirmed'
      }));

      return await this.batchTransfer(transfers, idempotencyKey);
    } catch (error) {
      logger.error('Error in multi-transfer:', error);
      throw new AppError(
        'Failed to execute multi-transfer',
        500,
        'MULTI_TRANSFER_FAILED'
      );
    }
  }

  /**
   * Calculate total amount needed including fees and reserves
   * @param {number} transferAmount - Amount to transfer
   * @param {number} [feeEstimate] - Estimated fee (default: 0.000005 SOL)
   * @returns {number} Total amount needed
   */
  calculateTotalNeeded(transferAmount, feeEstimate = 0.000005) {
    const MIN_RESERVE = 0.0001;
    return transferAmount + feeEstimate + MIN_RESERVE;
  }
}

module.exports = new SolService();
