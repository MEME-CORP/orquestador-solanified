const axios = require('axios');
const logger = require('../utils/logger');
const { AppError } = require('../middleware/errorHandler');

class ApiClient {
  constructor() {
    this.lastWarmupTimestamp = 0;
    this.warmupPromise = null;
    this.WARMUP_TTL_MS = 5 * 60 * 1000; // cache warm state for 5 minutes

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
      async (config) => {
        if (!config.__skipWarmup) {
          await this.ensureExternalApiReady();
        } else {
          delete config.__skipWarmup; // internal requests bypass warm-up checks
        }

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
        const originalRequest = error.config || {};

        logger.error('API Error:', {
          status: error.response?.status,
          url: originalRequest.url,
          method: originalRequest.method?.toUpperCase(),
          message: error.response?.data?.error?.message || error.message
        });

        if (this.shouldRetry(error)) {
          const isRateLimit = this.isRateLimitError(error);
          const maxRetries = isRateLimit ? 5 : 3;

          originalRequest._retryCount = originalRequest._retryCount || 0;

          if (originalRequest._retryCount < maxRetries) {
            originalRequest._retryCount += 1;

            let delay;
            if (isRateLimit) {
              delay = Math.pow(2, originalRequest._retryCount) * 2000 + Math.random() * 1000;
              logger.warn(`Rate limit hit, retrying request in ${delay}ms (attempt ${originalRequest._retryCount}/${maxRetries})`, {
                url: originalRequest.url,
                method: originalRequest.method,
                status: error.response?.status,
                errorMessage: error.response?.data?.error || error.message
              });
            } else {
              delay = Math.pow(2, originalRequest._retryCount) * 1000;
              logger.info(`Server error, retrying request in ${delay}ms (attempt ${originalRequest._retryCount}/${maxRetries})`, {
                url: originalRequest.url,
                status: error.response?.status
              });
            }

            await this.sleep(delay);
            return this.client(originalRequest);
          }

          logger.error(`Max retries (${maxRetries}) exceeded for request`, {
            url: originalRequest.url,
            method: originalRequest.method,
            finalError: error.response?.data?.error || error.message
          });
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

  async requestRaw(config = {}) {
    return this.client.request({
      __skipWarmup: true,
      validateStatus: () => true,
      ...config
    });
  }

  async ensureExternalApiReady(force = false) {
    const now = Date.now();

    if (!force && this.lastWarmupTimestamp && now - this.lastWarmupTimestamp < this.WARMUP_TTL_MS) {
      return;
    }

    if (this.warmupPromise) {
      return this.warmupPromise;
    }

    const timeoutMs = Number(process.env.EXTERNAL_API_WARMUP_TIMEOUT_MS || 90000);
    const cooldownMs = Number(process.env.EXTERNAL_API_WARMUP_COOLDOWN_MS || 20000);
    const maxAttempts = Number(process.env.EXTERNAL_API_WARMUP_ATTEMPTS || 2);

    this.warmupPromise = (async () => {
      try {
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          logger.info('🔥 [API_CLIENT] Warm-up request to blockchain API', {
            attempt,
            maxAttempts,
            timeout_ms: timeoutMs
          });

          const response = await this.client.request({
            method: 'GET',
            url: '/',
            timeout: timeoutMs,
            __skipWarmup: true,
            validateStatus: () => true
          });

          const status = response?.status ?? 0;

          if (status === 429) {
            if (attempt < maxAttempts) {
              const delay = cooldownMs * attempt;
              logger.warn('🔥 [API_CLIENT] Warm-up hit Render rate limit (429). Cooling down before retry', {
                attempt,
                delay_ms: delay
              });
              await this.sleep(delay);
              continue;
            }
            throw new Error('Warm-up blocked by rate limiting (429).');
          }

          if (status === 0 || status >= 500) {
            throw new Error(`Warm-up failed with upstream status ${status}.`);
          }

          this.lastWarmupTimestamp = Date.now();
          logger.info('🔥 [API_CLIENT] Blockchain API warm-up succeeded', {
            status
          });
          return;
        }
      } catch (error) {
        this.lastWarmupTimestamp = 0;
        logger.error('🔥 [API_CLIENT] Blockchain API warm-up failed', {
          error_message: error.message,
          error_status: error.response?.status
        });
        throw new AppError(
          'The blockchain API is waking up but did not respond in time. Please retry in a minute.',
          503,
          'BLOCKCHAIN_API_WARMING_UP'
        );
      } finally {
        this.warmupPromise = null;
      }
    })();

    return this.warmupPromise;
  }
}

module.exports = new ApiClient();
