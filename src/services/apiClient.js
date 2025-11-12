const axios = require('axios');
const http = require('http');
const https = require('https');
const { randomUUID } = require('crypto');
const logger = require('../utils/logger');
const { AppError } = require('../middleware/errorHandler');

class ApiClient {
  constructor() {
    this.lastWarmupTimestamp = 0;
    this.warmupPromise = null;
    this.WARMUP_TTL_MS = 5 * 60 * 1000; // cache warm state for 5 minutes
    this.activeWarmups = 0;
    this.DIAGNOSTICS_ENABLED = process.env.EXTERNAL_API_WARMUP_DIAGNOSTICS === 'true';
    this.warmupMode = (process.env.EXTERNAL_API_WARMUP_MODE || 'active').toLowerCase();
    this.lastWarmupRunId = null;
    this.rateLimitDelaysMs = this.parseDelays(
      process.env.EXTERNAL_API_RATE_LIMIT_DELAYS_MS,
      [45000, 60000, 90000, 120000, 150000]
    );
    this.rateLimitWarmupOnRetry = process.env.EXTERNAL_API_RATE_LIMIT_WARMUP !== 'false';
    this.userAgent = process.env.EXTERNAL_API_USER_AGENT || 'curl/8.5.0';
    this.healthCheckPath = process.env.EXTERNAL_API_HEALTHZ_PATH || '/';
    this.routerWarmupTimeoutMs = Number(process.env.EXTERNAL_API_ROUTER_WARMUP_TIMEOUT_MS || 75000);
    this.routerWarmCooldownMs = Number(process.env.EXTERNAL_API_ROUTER_WARMUP_COOLDOWN_MS || 120000);

    const baseURL = process.env.EXTERNAL_API_BASE_URL || 'https://rawapisolana-render.onrender.com';
    const apiKey = process.env.EXTERNAL_API_KEY ? String(process.env.EXTERNAL_API_KEY).trim() : '';
    const defaultHeaders = {
      'Content-Type': 'application/json',
      'Accept': '*/*',
      'User-Agent': this.userAgent
    };

    if (apiKey) {
      defaultHeaders.Authorization = `Bearer ${apiKey}`;
    }

    this.client = axios.create({
      baseURL,
      timeout: 120000, // 2 minutes for blockchain operations (increased from 30s)
      headers: defaultHeaders,
      httpAgent: new http.Agent({ keepAlive: false }),
      httpsAgent: new https.Agent({ keepAlive: false })
    });

    // Dedicated warm-up client without interceptors or automatic retries
    this.warmupClient = axios.create({
      baseURL,
      timeout: 120000,
      headers: {
        ...defaultHeaders,
        'Content-Type': 'application/json'
      },
      validateStatus: () => true,
      httpAgent: new http.Agent({ keepAlive: false }),
      httpsAgent: new https.Agent({ keepAlive: false })
    });

    // Request interceptor for logging and idempotency
    this.client.interceptors.request.use(
      async (config) => {
        if (!config.__skipWarmup) {
          if (this.warmupMode !== 'active') {
            this.diagLog('info', ' [API_CLIENT] Warm-up skipped due to mode', {
              url: config.url,
              method: config.method?.toUpperCase(),
              warmup_mode: this.warmupMode
            });
          }

          const warmStateAge = this.lastWarmupTimestamp ? Date.now() - this.lastWarmupTimestamp : null;
          this.diagLog('info', '🔥 [API_CLIENT] Warm-up check prior to outbound request', {
            url: config.url,
            method: config.method?.toUpperCase(),
            warm_state_age_ms: warmStateAge,
            warmup_inflight: this.activeWarmups,
            request_has_idempotency_key: Boolean(config.idempotencyKey)
          });

          const warmupContext = await this.ensureExternalApiReady({ reason: 'request_interceptor' });
          if (warmupContext?.warmupRunId) {
            config.__warmupRunId = warmupContext.warmupRunId;
          }
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
          data: config.data ? 'present' : 'none',
          warmup_run_id: config.__warmupRunId || null
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
          method: response.config.method?.toUpperCase(),
          warmup_run_id: response.config.__warmupRunId || null
        });
        return response;
      },
      async (error) => {
        const originalRequest = error.config || {};
        const responseBodySample = this.safeSampleBody(error.response?.data);
        const renderRoutingHeader = this.getRenderRoutingHeader(error.response?.headers);
        const retryAfterHeader = this.getRetryAfterHeader(error.response?.headers);
        const routerSuggestedDelay = this.getRenderRoutingDelay(renderRoutingHeader, retryAfterHeader);
        const routerBlocked = this.isRenderRouterBlocked(error.response?.status, renderRoutingHeader);

        logger.error('API Error:', {
          status: error.response?.status,
          url: originalRequest.url,
          method: originalRequest.method?.toUpperCase(),
          message: error.response?.data?.error?.message || error.message,
          warmup_run_id: originalRequest.__warmupRunId || null,
          response_body_sample: responseBodySample,
          render_routing: renderRoutingHeader,
          retry_after_header: retryAfterHeader
        });

        if (error.response?.status === 429 && routerBlocked) {
          if (originalRequest.__routerWarmAttempted) {
            logger.warn('🔥 [API_CLIENT] Router 429 persisted after warm-up attempt, aborting retries', {
              url: originalRequest.url,
              method: originalRequest.method,
              warmup_run_id: originalRequest.__warmupRunId || null,
              render_routing: renderRoutingHeader,
              retry_after_header: retryAfterHeader
            });
            return Promise.reject(error);
          }

          originalRequest.__routerWarmAttempted = true;

          if (routerSuggestedDelay) {
            this.diagLog('info', '🔥 [API_CLIENT] Honoring router suggested delay before warm-up', {
              delay_ms: routerSuggestedDelay,
              render_routing: renderRoutingHeader,
              retry_after_header: retryAfterHeader || null
            });
            await this.sleep(routerSuggestedDelay);
          }

          try {
            const warmupContext = await this.ensureExternalApiReady({
              force: true,
              bypassModeCheck: true,
              reason: 'router_rate_limit',
              timeoutOverrideMs: this.routerWarmupTimeoutMs
            });

            if (warmupContext?.warmupRunId) {
              originalRequest.__warmupRunId = warmupContext.warmupRunId;
            }

            logger.info('🔥 [API_CLIENT] Render router warm-up completed, retrying request once', {
              url: originalRequest.url,
              method: originalRequest.method,
              warmup_run_id: warmupContext?.warmupRunId || null
            });
          } catch (warmupError) {
            logger.error('🔥 [API_CLIENT] Render router warm-up failed', {
              url: originalRequest.url,
              method: originalRequest.method,
              error_message: warmupError.message,
              render_routing: renderRoutingHeader,
              warmup_run_id: warmupError.warmupRunId || null
            });
            return Promise.reject(error);
          }

          originalRequest.__skipWarmup = true;
          return this.client(originalRequest);
        }

        if (this.shouldRetry(error)) {
          const isRateLimit = this.isRateLimitError(error);
          const maxRetries = isRateLimit ? this.rateLimitDelaysMs.length : 3;

          originalRequest._retryCount = originalRequest._retryCount || 0;

          if (originalRequest._retryCount < maxRetries) {
            originalRequest._retryCount += 1;

            let delay;
            if (isRateLimit) {
              const attemptIndex = originalRequest._retryCount - 1;
              delay = routerSuggestedDelay ?? this.getRateLimitDelay(attemptIndex);

              if (this.rateLimitWarmupOnRetry) {
                try {
                  const warmupContext = await this.ensureExternalApiReady({
                    force: true,
                    reason: 'rate_limit_retry'
                  });
                  if (warmupContext?.warmupRunId) {
                    originalRequest.__warmupRunId = warmupContext.warmupRunId;
                  }
                } catch (warmupError) {
                  logger.warn('🔥 [API_CLIENT] Warm-up during rate-limit retry failed', {
                    retry_attempt: originalRequest._retryCount,
                    error_message: warmupError.message,
                    warmup_run_id: warmupError.warmupRunId || null
                  });
                }
              }

              logger.warn(`Rate limit hit, retrying request in ${delay}ms (attempt ${originalRequest._retryCount}/${maxRetries})`, {
                url: originalRequest.url,
                method: originalRequest.method,
                status: error.response?.status,
                errorMessage: error.response?.data?.error || error.message,
                warmup_run_id: originalRequest.__warmupRunId || null,
                response_body_sample: responseBodySample,
                render_routing: renderRoutingHeader,
                retry_after_header: retryAfterHeader
              });
            } else {
              delay = Math.pow(2, originalRequest._retryCount) * 1000;
              logger.info(`Server error, retrying request in ${delay}ms (attempt ${originalRequest._retryCount}/${maxRetries})`, {
                url: originalRequest.url,
                status: error.response?.status,
                warmup_run_id: originalRequest.__warmupRunId || null
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

  async ensureExternalApiReady(options = {}) {
    if (typeof options === 'boolean') {
      options = { force: options };
    }

    const {
      force = false,
      bypassModeCheck = false,
      reason = 'unspecified',
      timeoutOverrideMs
    } = options;

    if (!bypassModeCheck && this.warmupMode !== 'active') {
      return {
        warmupSkipped: true,
        warmupMode: this.warmupMode,
        warmupRunId: this.lastWarmupRunId
      };
    }

    const now = Date.now();

    if (!force && this.lastWarmupTimestamp && now - this.lastWarmupTimestamp < this.WARMUP_TTL_MS) {
      this.diagLog('info', '🔥 [API_CLIENT] Warm-up skipped - cached warm state still valid', {
        warm_state_age_ms: now - this.lastWarmupTimestamp,
        warmup_run_id: this.lastWarmupRunId,
        ttl_ms: this.WARMUP_TTL_MS,
        reason
      });
      return {
        warmupCached: true,
        warmupRunId: this.lastWarmupRunId
      };
    }

    if (this.warmupPromise) {
      return this.warmupPromise;
    }

    const timeoutMs = timeoutOverrideMs || Number(process.env.EXTERNAL_API_WARMUP_TIMEOUT_MS || 120000);
    const cooldownMs = Number(process.env.EXTERNAL_API_WARMUP_COOLDOWN_MS || 30000);
    const maxAttempts = Number(process.env.EXTERNAL_API_WARMUP_ATTEMPTS || 5);
    const min429Delay = Number(process.env.EXTERNAL_API_WARMUP_429_DELAY_MS || 45000);

    const warmupRunId = randomUUID();
    this.activeWarmups += 1;
    this.diagLog('info', '🔥 [API_CLIENT] Warm-up sequence started', {
      warmup_run_id: warmupRunId,
      warmups_inflight: this.activeWarmups,
      force,
      ttl_ms: this.WARMUP_TTL_MS,
      reason,
      timeout_ms: timeoutMs
    });

    this.warmupPromise = (async () => {
      try {
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          const attemptStartedAt = Date.now();
          this.diagLog('info', '🔥 [API_CLIENT] Warm-up request to blockchain API', {
            attempt,
            maxAttempts,
            timeout_ms: timeoutMs,
            warmup_run_id: warmupRunId,
            warmups_inflight: this.activeWarmups
          });

          const response = await this.warmupClient.request({
            method: 'GET',
            url: this.healthCheckPath,
            timeout: timeoutMs
          });

          const status = response?.status ?? 0;
          const attemptDuration = Date.now() - attemptStartedAt;
          const renderRoutingHeader = this.getRenderRoutingHeader(response?.headers);
          const retryAfterHeader = this.getRetryAfterHeader(response?.headers);
          const routerSuggestedDelay = this.getRenderRoutingDelay(renderRoutingHeader, retryAfterHeader);
          const responseBodySample = this.safeSampleBody(response?.data);

          if (status === 429) {
            const delay = routerSuggestedDelay ?? Math.max(min429Delay, cooldownMs * attempt);
            this.diagLog('warn', '🔥 [API_CLIENT] Warm-up hit Render rate limit (429). Waiting for Render cold start window to expire', {
              attempt,
              delay_ms: delay,
              warmup_run_id: warmupRunId,
              attempt_duration_ms: attemptDuration,
              retry_after_header: retryAfterHeader || null,
              response_body_sample: responseBodySample,
              render_routing: renderRoutingHeader
            });
            await this.sleep(delay);
            continue;
          }

          if (status === 0 || status >= 500) {
            const errorPayload = {
              status,
              warmup_run_id: warmupRunId,
              attempt,
              attempt_duration_ms: attemptDuration,
              response_body_sample: responseBodySample,
              render_routing: renderRoutingHeader
            };
            this.diagLog('error', '🔥 [API_CLIENT] Warm-up received unhealthy upstream response', errorPayload);
            throw new Error(`Warm-up failed with upstream status ${status}.`);
          }

          this.lastWarmupTimestamp = Date.now();
          this.lastWarmupRunId = warmupRunId;
          this.diagLog('info', '🔥 [API_CLIENT] Blockchain API warm-up succeeded', {
            status,
            warmup_run_id: warmupRunId,
            attempt,
            attempt_duration_ms: attemptDuration,
            warmups_inflight: this.activeWarmups - 1
          });

          return {
            warmupRunId,
            warmupTriggered: true,
            status
          };
        }

        throw new Error('Warm-up attempts exhausted without a healthy response.');
      } catch (error) {
        this.lastWarmupTimestamp = 0;
        this.lastWarmupRunId = warmupRunId;
        this.diagLog('error', '🔥 [API_CLIENT] Blockchain API warm-up failed', {
          error_message: error.message,
          error_status: error.response?.status,
          warmup_run_id: warmupRunId,
          render_routing: error.response?.headers ? this.getRenderRoutingHeader(error.response.headers) : null,
          retry_after_header: error.response?.headers ? this.getRetryAfterHeader(error.response.headers) : null
        });

        const warmupError = new AppError(
          'The blockchain API is waking up but did not respond in time. Please retry in a minute.',
          503,
          'BLOCKCHAIN_API_WARMING_UP'
        );
        warmupError.warmupRunId = warmupRunId;
        warmupError.details = {
          warmupRunId,
          warmupMode: this.warmupMode,
          attempts: maxAttempts,
          renderRouting: error.response?.headers ? this.getRenderRoutingHeader(error.response.headers) : null,
          retryAfter: error.response?.headers ? this.getRetryAfterHeader(error.response.headers) : null
        };
        throw warmupError;
      } finally {
        this.warmupPromise = null;
        this.activeWarmups = Math.max(0, this.activeWarmups - 1);
        this.diagLog('info', '🔥 [API_CLIENT] Warm-up sequence finished', {
          warmup_run_id: warmupRunId,
          warmups_inflight: this.activeWarmups
        });
      }
    })();

    return this.warmupPromise;
  }

  isRenderRouterBlocked(status, renderRoutingHeader) {
    if (status !== 429 && status !== 503) {
      return false;
    }

    if (!renderRoutingHeader) {
      return false;
    }

    const headerValue = renderRoutingHeader.toLowerCase();
    return headerValue.includes('rate-limited') || headerValue.includes('dynamic-hibernate') || headerValue.includes('hibernate');
  }

  diagLog(level, message, metadata = {}) {
    if (!this.DIAGNOSTICS_ENABLED) {
      return;
    }

    const payload = {
      ...metadata,
      service: 'bundler-orchestrator'
    };

    if (typeof logger[level] === 'function') {
      logger[level](message, payload);
    } else {
      logger.info(message, payload);
    }
  }

  safeSampleBody(data) {
    if (!data) {
      return null;
    }

    try {
      if (typeof data === 'string') {
        return data.slice(0, 200);
      }

      return JSON.stringify(data).slice(0, 200);
    } catch (error) {
      return '[unserializable response body]';
    }
  }

  getRetryAfterHeader(headers = {}) {
    if (!headers) {
      return null;
    }

    return headers['retry-after'] || headers['Retry-After'] || null;
  }

  getRenderRoutingHeader(headers = {}) {
    if (!headers) {
      return null;
    }

    return headers['x-render-routing'] || headers['X-Render-Routing'] || null;
  }

  getRenderRoutingDelay(renderRoutingHeader, retryAfterHeader) {
    if (retryAfterHeader) {
      const parsedSeconds = Number(retryAfterHeader);
      if (Number.isFinite(parsedSeconds) && parsedSeconds >= 0) {
        return parsedSeconds * 1000;
      }

      const parsedDate = Date.parse(retryAfterHeader);
      if (!Number.isNaN(parsedDate)) {
        const diff = parsedDate - Date.now();
        if (diff > 0) {
          return diff;
        }
      }
    }

    if (!renderRoutingHeader) {
      return null;
    }

    const headerValue = renderRoutingHeader.toLowerCase();
    const defaultRateLimitDelay = Number(process.env.EXTERNAL_API_RENDER_ROUTER_DELAY_MS || 90000);
    const defaultHibernateDelay = Number(process.env.EXTERNAL_API_RENDER_HIBERNATE_DELAY_MS || 60000);

    if (headerValue.includes('rate-limited')) {
      return defaultRateLimitDelay;
    }

    if (headerValue.includes('dynamic-hibernate')) {
      return defaultHibernateDelay;
    }

    return null;
  }

  parseDelays(envValue, fallback) {
    if (!envValue) {
      return fallback;
    }

    const parsed = envValue
      .split(',')
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isFinite(value) && value > 0);

    return parsed.length ? parsed : fallback;
  }

  getRateLimitDelay(attemptIndex) {
    const clampedIndex = Math.min(attemptIndex, this.rateLimitDelaysMs.length - 1);
    return this.rateLimitDelaysMs[clampedIndex];
  }
}

module.exports = new ApiClient();
