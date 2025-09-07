const logger = require('./logger');

/**
 * Retry configuration and utilities for handling API rate limits and failures
 */
class RetryConfig {
  /**
   * Default retry configurations for different operation types
   */
  static get DEFAULTS() {
    return {
      // For balance checks (frequent, low impact)
      BALANCE_CHECK: {
        maxRetries: 3,
        baseDelay: 1000,     // 1 second
        maxDelay: 8000,      // 8 seconds
        backoffMultiplier: 2,
        jitterRange: 500,    // ±500ms random jitter
        rateLimitRetries: 5  // More retries for rate limits
      },
      
      // For transfers (critical, higher impact)
      TRANSFER: {
        maxRetries: 3,
        baseDelay: 2000,     // 2 seconds
        maxDelay: 16000,     // 16 seconds
        backoffMultiplier: 2,
        jitterRange: 1000,   // ±1000ms random jitter
        rateLimitRetries: 4  // Fewer but longer retries for rate limits
      },
      
      // For token operations (very critical)
      TOKEN_OPERATION: {
        maxRetries: 2,
        baseDelay: 3000,     // 3 seconds
        maxDelay: 12000,     // 12 seconds
        backoffMultiplier: 2,
        jitterRange: 1500,   // ±1500ms random jitter
        rateLimitRetries: 3
      }
    };
  }

  /**
   * Calculate delay for a retry attempt
   * @param {number} attempt - Current attempt number (1-based)
   * @param {Object} config - Retry configuration
   * @returns {number} Delay in milliseconds
   */
  static calculateDelay(attempt, config) {
    const exponentialDelay = config.baseDelay * Math.pow(config.backoffMultiplier, attempt - 1);
    const cappedDelay = Math.min(exponentialDelay, config.maxDelay);
    const jitter = (Math.random() - 0.5) * 2 * config.jitterRange; // Random jitter ±range
    
    return Math.max(0, cappedDelay + jitter);
  }

  /**
   * Check if an error indicates rate limiting
   * @param {Error} error - The error to check
   * @returns {boolean} True if it's a rate limit error
   */
  static isRateLimitError(error) {
    const status = error.response?.status;
    const errorMessage = error.response?.data?.error || error.message || '';
    
    return (
      status === 400 && (
        errorMessage.includes('Rate limit exceeded') ||
        errorMessage.includes('rate limit') ||
        errorMessage.includes('too many requests') ||
        errorMessage.includes('max 4 req/s') ||
        errorMessage.includes('max requests per second')
      )
    ) || status === 429; // Standard HTTP 429 Too Many Requests
  }

  /**
   * Check if an error is retryable
   * @param {Error} error - The error to check
   * @param {Array<string>} nonRetryableCodes - Error codes that shouldn't be retried
   * @returns {boolean} True if the error should be retried
   */
  static isRetryableError(error, nonRetryableCodes = []) {
    // Don't retry specific error codes
    if (error.code && nonRetryableCodes.includes(error.code)) {
      return false;
    }

    // Don't retry validation errors (4xx except rate limits)
    const status = error.response?.status;
    if (status >= 400 && status < 500 && !this.isRateLimitError(error)) {
      return false;
    }

    // Retry on rate limits, 5xx errors, network errors
    return (
      this.isRateLimitError(error) ||
      !error.response ||
      status >= 500 ||
      error.code === 'ECONNREFUSED' ||
      error.code === 'ETIMEDOUT' ||
      error.code === 'ENOTFOUND' ||
      error.code === 'ECONNRESET'
    );
  }

  /**
   * Execute a function with retry logic
   * @param {Function} fn - Function to execute
   * @param {Object} config - Retry configuration
   * @param {string} operationName - Name for logging
   * @param {Array<string>} nonRetryableCodes - Error codes that shouldn't be retried
   * @returns {Promise} Result of the function
   */
  static async executeWithRetry(fn, config, operationName = 'operation', nonRetryableCodes = []) {
    let lastError;
    const isRateLimitSensitive = config.rateLimitRetries > config.maxRetries;
    
    for (let attempt = 1; attempt <= config.maxRetries + 1; attempt++) {
      try {
        // Execute the function
        const result = await fn(attempt);
        
        // Log successful retry
        if (attempt > 1) {
          logger.info(`${operationName} succeeded after retry`, {
            attempt,
            totalAttempts: config.maxRetries + 1
          });
        }
        
        return result;
      } catch (error) {
        lastError = error;
        
        // Check if we should retry
        const isRateLimit = this.isRateLimitError(error);
        const isRetryable = this.isRetryableError(error, nonRetryableCodes);
        
        // For rate limits, use extended retry count if configured
        const maxRetries = isRateLimit && isRateLimitSensitive ? 
          config.rateLimitRetries : config.maxRetries;
        
        const shouldRetry = isRetryable && attempt <= maxRetries;
        
        if (!shouldRetry) {
          // Log final failure
          logger.error(`${operationName} failed after ${attempt} attempts`, {
            error: error.message,
            isRateLimit,
            isRetryable,
            finalAttempt: true
          });
          break;
        }
        
        // Calculate delay
        const delay = this.calculateDelay(attempt, config);
        
        // Log retry attempt
        logger.warn(`${operationName} failed, retrying in ${delay}ms`, {
          attempt,
          maxRetries: maxRetries + 1,
          error: error.message,
          isRateLimit,
          delay
        });
        
        // Wait before retry
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    
    // All retries exhausted
    throw lastError;
  }

  /**
   * Create a retry wrapper for a function
   * @param {Function} fn - Function to wrap
   * @param {Object} config - Retry configuration
   * @param {string} operationName - Name for logging
   * @param {Array<string>} nonRetryableCodes - Error codes that shouldn't be retried
   * @returns {Function} Wrapped function with retry logic
   */
  static withRetry(fn, config, operationName, nonRetryableCodes = []) {
    return async (...args) => {
      return this.executeWithRetry(
        (attempt) => fn(...args, { attempt }),
        config,
        operationName,
        nonRetryableCodes
      );
    };
  }
}

module.exports = RetryConfig;
