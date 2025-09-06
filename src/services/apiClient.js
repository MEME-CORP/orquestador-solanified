const axios = require('axios');
const logger = require('../utils/logger');

class ApiClient {
  constructor() {
    this.client = axios.create({
      baseURL: process.env.EXTERNAL_API_BASE_URL || 'https://rawapisolana-render.onrender.com:10000',
      timeout: 30000, // 30 seconds for blockchain operations
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

        // Retry logic for 5xx errors and network issues
        if (this.shouldRetry(error) && !originalRequest._retry && originalRequest._retryCount < 3) {
          originalRequest._retry = true;
          originalRequest._retryCount = (originalRequest._retryCount || 0) + 1;

          const delay = Math.pow(2, originalRequest._retryCount) * 10000; // Exponential backoff
          logger.info(`Retrying request in ${delay}ms (attempt ${originalRequest._retryCount})`);

          await this.sleep(delay);
          return this.client(originalRequest);
        }

        return Promise.reject(error);
      }
    );
  }

  shouldRetry(error) {
    // Retry on 5xx errors, network errors, or timeout
    return (
      !error.response ||
      error.response.status >= 500 ||
      error.code === 'ECONNREFUSED' ||
      error.code === 'ETIMEDOUT' ||
      error.code === 'ENOTFOUND'
    );
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
