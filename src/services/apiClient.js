const axios = require('axios');
const logger = require('../utils/logger');

class ApiClient {
  constructor() {
    this.client = axios.create({
      baseURL: process.env.EXTERNAL_API_BASE_URL || 'https://rawapisolana-render.onrender.com',
      timeout: 120000, // 2 minutes for blockchain operations (increased from 30s)
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.EXTERNAL_API_KEY || ''}`
      }
    });

    // Request interceptor for logging and idempotency
    this.client.interceptors.request.use(
      (config) => {
        // Add idempotency key if provided
        if (config.idempotencyKey) {
          config.headers['X-Idempotency-Key'] = config.idempotencyKey;
          delete config.idempotencyKey;
        }

        logger.info('API Request:', {
          method: config.method?.toUpperCase(),
          url: config.url,
          data: config.data ? 'present' : 'none'
        });

        return config;
      },
      (error) => {
        logger.error('Request interceptor error:', error);
        return Promise.reject(error);
      }
    );

    // Response interceptor for logging and error handling
    this.client.interceptors.response.use(
      (response) => {
        logger.info('API Response:', {
          status: response.status,
          url: response.config.url,
          method: response.config.method?.toUpperCase()
        });
        return response;
      },
      async (error) => {
        const originalRequest = error.config;

        // Log the error
        logger.error('API Error:', {
          status: error.response?.status,
          url: error.config?.url,
          method: error.config?.method?.toUpperCase(),
          message: error.response?.data?.error?.message || error.message
        });

        // Enhanced retry logic for 5xx errors, network issues, and rate limiting
        if (this.shouldRetry(error) && !originalRequest._retry) {
          const maxRetries = this.isRateLimitError(error) ? 5 : 3; // More retries for rate limits
          
          if (originalRequest._retryCount < maxRetries) {
            originalRequest._retry = true;
            originalRequest._retryCount = (originalRequest._retryCount || 0) + 1;

            let delay;
            if (this.isRateLimitError(error)) {
              // For rate limiting: use longer, more aggressive backoff
              delay = Math.pow(2, originalRequest._retryCount) * 2000 + Math.random() * 1000; // 2s, 4s, 8s, 16s, 32s + jitter
              logger.warn(`Rate limit hit, retrying request in ${delay}ms (attempt ${originalRequest._retryCount}/${maxRetries})`, {
                url: originalRequest.url,
                method: originalRequest.method,
                status: error.response?.status,
                errorMessage: error.response?.data?.error || error.message
              });
            } else {
              // For server errors: standard exponential backoff
              delay = Math.pow(2, originalRequest._retryCount) * 1000; // 2s, 4s, 8s
              logger.info(`Server error, retrying request in ${delay}ms (attempt ${originalRequest._retryCount}/${maxRetries})`, {
                url: originalRequest.url,
                status: error.response?.status
              });
            }

            await this.sleep(delay);
            
            // Reset the retry flag for the next attempt
            originalRequest._retry = false;
            return this.client(originalRequest);
          } else {
            logger.error(`Max retries (${maxRetries}) exceeded for request`, {
              url: originalRequest.url,
              method: originalRequest.method,
              finalError: error.response?.data?.error || error.message
            });
          }
        }

        return Promise.reject(error);
      }
    );
  }

  shouldRetry(error) {
    // Retry on 5xx errors, network errors, timeout, or rate limiting
    return (
      !error.response ||
      error.response.status >= 500 ||
      error.code === 'ECONNREFUSED' ||
      error.code === 'ETIMEDOUT' ||
      error.code === 'ENOTFOUND' ||
      this.isRateLimitError(error)
    );
  }

  isRateLimitError(error) {
    // Check for rate limiting indicators
    const status = error.response?.status;
    const errorMessage = error.response?.data?.error || error.message || '';
    
    return (
      status === 400 && (
        errorMessage.includes('Rate limit exceeded') ||
        errorMessage.includes('rate limit') ||
        errorMessage.includes('too many requests') ||
        errorMessage.includes('max 4 req/s')
      )
    ) || status === 429; // Standard HTTP 429 Too Many Requests
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async get(url, config = {}) {
    const response = await this.client.get(url, config);
    return response.data;
  }

  async post(url, data = {}, config = {}) {
    const response = await this.client.post(url, data, config);
    return response.data;
  }

  async put(url, data = {}, config = {}) {
    const response = await this.client.put(url, data, config);
    return response.data;
  }

  async delete(url, config = {}) {
    const response = await this.client.delete(url, config);
    return response.data;
  }
}

module.exports = new ApiClient();
