const logger = require('../utils/logger');

class AppError extends Error {
  constructor(message, statusCode, code = null) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = true;

    Error.captureStackTrace(this, this.constructor);
  }
}

const errorHandler = (err, req, res, next) => {
  let error = { ...err };
  error.message = err.message;

  // Log error
  logger.error('Error occurred:', {
    error: error.message,
    stack: err.stack,
    url: req.url,
    method: req.method,
    body: req.body,
    params: req.params,
    query: req.query
  });

  // Default error
  let message = 'Internal Server Error';
  let statusCode = 500;
  let code = 'INTERNAL_ERROR';

  // Handle specific error types
  if (error.isOperational) {
    message = error.message;
    statusCode = error.statusCode;
    code = error.code || 'OPERATIONAL_ERROR';
  }

  // Joi validation errors
  if (error.isJoi) {
    message = error.details[0].message;
    statusCode = 400;
    code = 'VALIDATION_ERROR';
  }

  // PostgreSQL errors
  if (error.code && error.code.startsWith('23')) {
    message = 'Database constraint violation';
    statusCode = 409;
    code = 'CONSTRAINT_VIOLATION';
  }

  // Axios errors (external API)
  if (error.response) {
    message = `External API error: ${error.response.data?.error?.message || error.message}`;
    statusCode = error.response.status === 502 ? 502 : 500;
    code = 'EXTERNAL_API_ERROR';
  }

  // Network errors
  if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
    message = 'External service unavailable';
    statusCode = 502;
    code = 'SERVICE_UNAVAILABLE';
  }

  res.status(statusCode).json({
    ok: false,
    error: {
      code,
      message
    }
  });
};

module.exports = { errorHandler, AppError };
