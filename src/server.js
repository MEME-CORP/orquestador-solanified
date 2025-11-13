const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const logger = require('./utils/logger');
const { errorHandler } = require('./middleware/errorHandler');
const orchestratorRoutes = require('./routes/orchestrator');

const app = express();
const PORT = process.env.PORT || 3000;

// Render terminates TLS/proxy upstream, so enable trust proxy to read X-Forwarded-* safely
app.set('trust proxy', 1);

const rawAllowedOrigins = process.env.ALLOWED_ORIGINS || '';
const allowedOrigins = rawAllowedOrigins
  .split(',')
  .map(origin => origin.trim().replace(/\/$/, ''))
  .filter(Boolean);

const corsOptions = {
  origin: allowedOrigins.length === 0
    ? true
    : (origin, callback) => {
        if (!origin) {
          return callback(null, true);
        }

        const normalizedOrigin = origin.replace(/\/$/, '');

        if (allowedOrigins.includes(normalizedOrigin)) {
          return callback(null, true);
        }

        logger.warn('Blocked CORS request from unauthorized origin', {
          origin,
          normalizedOrigin,
          allowedOrigins
        });

        return callback(new Error('Not allowed by CORS'));
      },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Accept', 'Authorization'],
  preflightContinue: false,
  optionsSuccessStatus: 204
};

// Security middleware
app.use(helmet());
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// Rate limiting (defaults can be overridden via environment)
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000);
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 100);

const limiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many requests from this IP, please try again later.'
});

app.use(limiter);

// Body parsing middleware
app.use(express.json({ limit: '10mb' })); // Increased for base64 images
app.use(express.urlencoded({ extended: true }));

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// API routes
app.use('/api/orchestrator', orchestratorRoutes);

// Error handling middleware
app.use(errorHandler);

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    error: {
      code: 'NOT_FOUND',
      message: `Route ${req.originalUrl} not found`
    }
  });
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down gracefully');
  process.exit(0);
});

app.listen(PORT, () => {
  logger.info(`Orchestrator API listening on port ${PORT}`);
});

module.exports = app;
