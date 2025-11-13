const axios = require('axios');
const http = require('http');
const https = require('https');
const { randomUUID } = require('crypto');

const logger = require('../utils/logger');
const { AppError } = require('../middleware/errorHandler');

const BASE_URL = process.env.EXTERNAL_API_BASE_URL || 'https://rawapisolana-render.onrender.com';
const HEALTH_PATH = process.env.EXTERNAL_API_HEALTHZ_PATH || '/';
const HEALTH_TIMEOUT_MS = Number(process.env.EXTERNAL_API_HEALTH_TIMEOUT_MS || 75000);
const HEALTH_TTL_MS = Number(process.env.EXTERNAL_API_HEALTH_TTL_MS || 2 * 60 * 1000);
const HEALTH_COOLDOWN_MS = Number(process.env.EXTERNAL_API_HEALTH_COOLDOWN_MS || 30000);
const HEALTH_RETRY_DELAY_MS = Number(process.env.EXTERNAL_API_HEALTH_RETRY_DELAY_MS || 5000);
const REQUEST_TIMEOUT_MS = Number(process.env.EXTERNAL_API_REQUEST_TIMEOUT_MS || 120000);
const DIAGNOSTICS_ENABLED = process.env.EXTERNAL_API_WARMUP_DIAGNOSTICS === 'true';

let lastHealthOkAt = 0;
let healthPromise = null;

const httpClient = axios.create({
  baseURL: BASE_URL,
  timeout: REQUEST_TIMEOUT_MS,
  headers: {
    'User-Agent':
      process.env.EXTERNAL_API_USER_AGENT ||
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    Accept:
      'application/json,text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': process.env.EXTERNAL_API_ACCEPT_LANGUAGE || 'en-US,en;q=0.9'
  },
  httpAgent: new http.Agent({ keepAlive: false }),
  httpsAgent: new https.Agent({ keepAlive: false })
});

function diag(level, message, metadata = {}) {
  if (!DIAGNOSTICS_ENABLED) {
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sampleBody(data) {
  if (data == null) {
    return null;
  }

  if (typeof data === 'string') {
    return data.slice(0, 200);
  }

  try {
    return JSON.stringify(data).slice(0, 200);
  } catch (error) {
    return '[unserializable response body]';
  }
}

function getRenderRouting(headers = {}) {
  if (!headers) {
    return null;
  }

  return headers['x-render-routing'] || headers['X-Render-Routing'] || null;
}

function looksLikeRenderHtmlChallenge(bodySample) {
  if (!bodySample) {
    return false;
  }

  const normalized = bodySample.toLowerCase();
  return (
    normalized.includes('<title>just a moment') ||
    normalized.includes('cf-ray') ||
    (normalized.includes('<html') && normalized.includes('challenge'))
  );
}

function buildRateLimitError(context = {}) {
  const error = new AppError(
    'Render router is rate limiting the raw API. Please retry after it wakes.',
    503,
    'BLOCKCHAIN_API_RATE_LIMITED'
  );
  error.details = context;
  return error;
}

async function ensureRawApiHealthy(options = {}) {
  const { force = false, reason = 'unspecified' } = options;
  const now = Date.now();

  if (!force && lastHealthOkAt && now - lastHealthOkAt < HEALTH_TTL_MS) {
    diag('info', 'RAW_API health cache valid', {
      age_ms: now - lastHealthOkAt,
      ttl_ms: HEALTH_TTL_MS,
      reason
    });
    return;
  }

  if (healthPromise) {
    return healthPromise;
  }

  const healthRunId = randomUUID();

  healthPromise = (async () => {
    diag('info', 'RAW_API health check start', {
      health_run_id: healthRunId,
      force,
      reason,
      ttl_ms: HEALTH_TTL_MS,
      timeout_ms: HEALTH_TIMEOUT_MS
    });

    try {
      const requestConfig = {
        method: 'GET',
        url: HEALTH_PATH,
        timeout: HEALTH_TIMEOUT_MS,
        validateStatus: () => true
      };

      const response = await httpClient.request(requestConfig);
      const status = response?.status ?? 0;
      const renderRouting = getRenderRouting(response?.headers);
      const bodySample = sampleBody(response?.data);

      diag('info', 'RAW_API health check response', {
        health_run_id: healthRunId,
        status,
        render_routing: renderRouting,
        body_sample: bodySample
      });

      if (status >= 200 && status < 300) {
        lastHealthOkAt = Date.now();
        return;
      }

      if (status === 429 || looksLikeRenderHtmlChallenge(bodySample) || /rate-limited|hibernate/i.test(renderRouting || '')) {
        throw buildRateLimitError({
          status,
          render_routing: renderRouting,
          body_sample: bodySample,
          health_run_id: healthRunId
        });
      }

      if ([502, 503, 504].includes(status)) {
        diag('warn', 'RAW_API health transient failure, retrying once', {
          health_run_id: healthRunId,
          status,
          retry_delay_ms: HEALTH_RETRY_DELAY_MS
        });

        await sleep(HEALTH_RETRY_DELAY_MS);
        const retryResponse = await httpClient.request(requestConfig);
        const retryStatus = retryResponse?.status ?? 0;
        const retryRouting = getRenderRouting(retryResponse?.headers);
        const retryBody = sampleBody(retryResponse?.data);

        diag('info', 'RAW_API health retry response', {
          health_run_id: healthRunId,
          status: retryStatus,
          render_routing: retryRouting,
          body_sample: retryBody
        });

        if (retryStatus >= 200 && retryStatus < 300) {
          lastHealthOkAt = Date.now();
          return;
        }

        if (retryStatus === 429 || looksLikeRenderHtmlChallenge(retryBody) || /rate-limited|hibernate/i.test(retryRouting || '')) {
          throw buildRateLimitError({
            status: retryStatus,
            render_routing: retryRouting,
            body_sample: retryBody,
            health_run_id: healthRunId,
            attempt: 'retry'
          });
        }

        throw new AppError(
          `Raw API health check failed after retry (status ${retryStatus}).`,
          503,
          'BLOCKCHAIN_API_HEALTH_UNAVAILABLE'
        );
      }

      throw new AppError(
        `Raw API health check returned unexpected status ${status}.`,
        503,
        'BLOCKCHAIN_API_HEALTH_UNEXPECTED'
      );
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }

      throw new AppError(
        `Raw API health check failed: ${error.message}`,
        503,
        'BLOCKCHAIN_API_HEALTH_FAILURE'
      );
    } finally {
      setTimeout(() => {
        healthPromise = null;
      }, HEALTH_COOLDOWN_MS).unref?.();
    }
  })();

  return healthPromise;
}

async function createWalletInRawApi(payload) {
  await ensureRawApiHealthy({ reason: 'wallet_create' });

  const requestConfig = {
    method: 'POST',
    url: '/api/v1/wallet/create',
    data: payload,
    timeout: REQUEST_TIMEOUT_MS
  };

  const requestStartedAt = Date.now();

  try {
    const response = await httpClient.request(requestConfig);
    lastHealthOkAt = Date.now();

    diag('info', 'RAW_API wallet create success', {
      status: response.status,
      duration_ms: Date.now() - requestStartedAt
    });

    return response.data;
  } catch (error) {
    const status = error.response?.status;
    const renderRouting = getRenderRouting(error.response?.headers);
    const bodySample = sampleBody(error.response?.data);
    const duration = Date.now() - requestStartedAt;

    diag('error', 'RAW_API wallet create failed', {
      status,
      render_routing: renderRouting,
      body_sample: bodySample,
      duration_ms: duration,
      message: error.message
    });

    if ([502, 503].includes(status) && !error.config?.__rawApiRetried) {
      error.config = error.config || requestConfig;
      error.config.__rawApiRetried = true;

      diag('warn', 'RAW_API wallet create retrying after transient error', {
        status,
        retry_delay_ms: HEALTH_RETRY_DELAY_MS
      });

      await sleep(HEALTH_RETRY_DELAY_MS);
      const retryResponse = await httpClient.request({ ...requestConfig, __rawApiRetried: true });
      lastHealthOkAt = Date.now();

      diag('info', 'RAW_API wallet create retry succeeded', {
        status: retryResponse.status,
        duration_ms: Date.now() - requestStartedAt
      });

      return retryResponse.data;
    }

    if (status === 429 || looksLikeRenderHtmlChallenge(bodySample) || /rate-limited/i.test(renderRouting || '')) {
      throw buildRateLimitError({
        status,
        render_routing: renderRouting,
        body_sample: bodySample
      });
    }

    if (!error.response) {
      throw new AppError(
        `Network error calling raw API: ${error.message}`,
        503,
        'BLOCKCHAIN_API_NETWORK_FAILURE'
      );
    }

    throw new AppError(
      `Raw API wallet create failed with status ${status}.`,
      status >= 500 ? 503 : status,
      'BLOCKCHAIN_API_WALLET_CREATE_FAILED'
    );
  }
}

module.exports = {
  ensureRawApiHealthy,
  createWalletInRawApi
};
