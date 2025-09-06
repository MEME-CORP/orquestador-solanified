const { createClient } = require('@supabase/supabase-js');
const { Pool } = require('pg');
const logger = require('../utils/logger');

// Supabase client for simple operations
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// PostgreSQL pool for complex transactions
let pgPool;

// Only create PostgreSQL pool if we have the required environment variables
if (process.env.DATABASE_URL || (process.env.SUPABASE_DB_PASSWORD && process.env.SUPABASE_URL)) {
  const connectionString = process.env.DATABASE_URL || 
    `postgresql://postgres:${process.env.SUPABASE_DB_PASSWORD}@db.${process.env.SUPABASE_URL.split('//')[1].split('.')[0]}.supabase.co:5432/postgres`;
  
  pgPool = new Pool({
    connectionString,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
  });
} else {
  logger.warn('PostgreSQL connection not configured. Only Supabase client will be available.');
}

// Test connections
const testConnections = async () => {
  try {
    // Test Supabase connection
    const { data, error } = await supabase.from('users').select('count').limit(1);
    if (error) throw error;
    logger.info('Supabase connection established');

    // Test PostgreSQL connection only if pool is available
    if (pgPool) {
      const client = await pgPool.connect();
      await client.query('SELECT NOW()');
      client.release();
      logger.info('PostgreSQL connection established');
    } else {
      logger.info('PostgreSQL connection skipped - not configured');
    }
  } catch (error) {
    logger.error('Database connection failed:', error);
    // Don't exit the process if only PostgreSQL fails but Supabase works
    if (error.message && error.message.includes('ENETUNREACH')) {
      logger.warn('PostgreSQL connection failed, continuing with Supabase client only');
      return;
    }
    throw error;
  }
};

// Initialize connections on startup
testConnections().catch(error => {
  logger.error('Failed to initialize database connections:', error);
  // Only exit if Supabase connection fails, not PostgreSQL
  if (!error.message || !error.message.includes('ENETUNREACH')) {
    process.exit(1);
  }
});

module.exports = {
  supabase,
  pgPool,
  testConnections
};
