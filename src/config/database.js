const { createClient } = require('@supabase/supabase-js');
const { Pool } = require('pg');
const logger = require('../utils/logger');

// Supabase client for simple operations
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// PostgreSQL pool for complex transactions
const pgPool = new Pool({
  connectionString: process.env.DATABASE_URL || `postgresql://postgres:${process.env.SUPABASE_DB_PASSWORD}@db.${process.env.SUPABASE_URL.split('//')[1].split('.')[0]}.supabase.co:5432/postgres`,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Test connections
const testConnections = async () => {
  try {
    // Test Supabase connection
    const { data, error } = await supabase.from('users').select('count').limit(1);
    if (error) throw error;
    logger.info('Supabase connection established');

    // Test PostgreSQL connection
    const client = await pgPool.connect();
    await client.query('SELECT NOW()');
    client.release();
    logger.info('PostgreSQL connection established');
  } catch (error) {
    logger.error('Database connection failed:', error);
    throw error;
  }
};

// Initialize connections on startup
testConnections().catch(error => {
  logger.error('Failed to initialize database connections:', error);
  process.exit(1);
});

module.exports = {
  supabase,
  pgPool,
  testConnections
};
