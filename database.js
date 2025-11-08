/**
 * SOLANAFIED - DATABASE CONNECTION & API LAYER
 * 
 * This file provides a connection layer to your Supabase database
 * based on the crypto wallets database structure provided.
 * 
 * SETUP INSTRUCTIONS:
 * 1. Replace 'YOUR_SUPABASE_URL' with your actual Supabase project URL
 * 2. Replace 'YOUR_SUPABASE_ANON_KEY' with your actual Supabase anon key
 * 3. Ensure your database tables match the structure in database_structure.txt
 * 4. Set up Row Level Security (RLS) policies as needed
 */

// ========== SUPABASE CONFIGURATION ==========

// Supabase credentials from environment
const SUPABASE_URL = 'https://rxkzujdzdtvxtyuhiane.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ4a3p1amR6ZHR2eHR5dWhpYW5lIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTcxMDM0NTksImV4cCI6MjA3MjY3OTQ1OX0.imamrxKrzbBKJBAcbQYXpRTFBx34J_mAXSWNCjQ0AGM';

// Initialize Supabase client
let supabaseClient = null;

/**
 * Initialize the Supabase connection
 * Call this before using any database functions
 */
function initializeDatabase() {
  try {
    if (typeof supabase === 'undefined') {
      throw new Error('Supabase library not loaded. Make sure to include the Supabase script in your HTML.');
    }
    
    supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    console.log('✅ Database connection initialized');
    return true;
  } catch (error) {
    console.error('❌ Failed to initialize database:', error);
    showSnackbar('Failed to connect to database', 'error');
    return false;
  }
}

// ========== UTILITY FUNCTIONS ==========

/**
 * Handle database errors consistently
 */
function handleDatabaseError(error, operation) {
  console.error(`Database error during ${operation}:`, error);
  
  let userMessage = 'Database operation failed';
  
  // Provide user-friendly error messages
  if (error.message.includes('network')) {
    userMessage = 'Network connection failed. Please check your internet connection.';
  } else if (error.message.includes('unauthorized') || error.code === '401') {
    userMessage = 'Authentication failed. Please reconnect your wallet.';
  } else if (error.message.includes('not found') || error.code === '404') {
    userMessage = 'Requested data not found.';
  } else if (error.message.includes('duplicate') || error.code === '23505') {
    userMessage = 'This record already exists.';
  }
  
  showSnackbar(userMessage, 'error');
  return null;
}

/**
 * Format balance values for display
 */
function formatBalance(balance, decimals = 9) {
  if (!balance) return '0.000';
  const num = parseFloat(balance);
  return num.toFixed(3);
}

/**
 * Truncate wallet addresses for display
 */
function truncateAddress(address, startChars = 4, endChars = 4) {
  if (!address) return '';
  if (address.length <= startChars + endChars) return address;
  return `${address.slice(0, startChars)}...${address.slice(-endChars)}`;
}

// ========== USER OPERATIONS ==========

/**
 * Get user by wallet ID
 */
async function getUserByWalletId(walletId) {
  if (!supabaseClient) {
    throw new Error('Database not initialized');
  }

  try {
    const { data, error } = await supabaseClient
      .from('users')
      .select('*')
      .eq('user_wallet_id', walletId)
      .maybeSingle();

    if (error) {
      if (error.code === 'PGRST116') {
        return null;
      }

      throw error;
    }

    if (!data) {
      console.debug('[DatabaseAPI] No user found for wallet:', walletId);
      return null;
    }

    return data;
  } catch (error) {
    handleDatabaseError(error, 'get user');
    throw error;
  }
}

/**
 * Update distributor wallet balances
 */
async function updateUserDistributorBalances(walletId, solBalance, splBalance) {
  try {
    if (!supabaseClient) {
      throw new Error('Database not initialized');
    }

    const { data, error } = await supabaseClient
      .from('users')
      .update({
        distributor_balance_sol: solBalance,
        distributor_balance_spl: splBalance
      })
      .eq('user_wallet_id', walletId)
      .select();

    if (error) throw error;

    return data[0];
  } catch (error) {
    return handleDatabaseError(error, 'update distributor balances');
  }
}

/**
 * Update developer wallet balances
 */
async function updateUserDevBalances(walletId, solBalance, splBalance) {
  try {
    if (!supabaseClient) {
      throw new Error('Database not initialized');
    }

    const { data, error } = await supabaseClient
      .from('users')
      .update({
        dev_balance_sol: solBalance,
        dev_balance_spl: splBalance
      })
      .eq('user_wallet_id', walletId)
      .select();

    if (error) throw error;

    return data[0];
  } catch (error) {
    return handleDatabaseError(error, 'update developer balances');
  }
}

/**
 * Backward-compatible wrapper for distributor balance updates
 */
async function updateUserBalances(walletId, solBalance, splBalance) {
  return updateUserDistributorBalances(walletId, solBalance, splBalance);
}

// ========== BUNDLER OPERATIONS ==========

/**
 * Get all bundlers for a user
 */
async function getUserBundlers(walletId) {
  try {
    if (!supabaseClient) {
      throw new Error('Database not initialized');
    }

    const { data, error } = await supabaseClient
      .from('bundlers')
      .select('*')
      .eq('user_wallet_id', walletId)
      .order('id', { ascending: false });

    if (error) throw error;
    
    return data || [];
  } catch (error) {
    return handleDatabaseError(error, 'get user bundlers') || [];
  }
}

/**
 * Create a new bundler
 */
async function createBundler(walletId, tokenName, isActive = true) {
  try {
    if (!supabaseClient) {
      throw new Error('Database not initialized');
    }

    const { data, error } = await supabaseClient
      .from('bundlers')
      .insert({
        user_wallet_id: walletId,
        token_name: tokenName,
        is_active: isActive,
        total_balance_sol: 0,
        total_balance_spl: 0
      })
      .select();

    if (error) throw error;
    
    console.log('✅ Bundler created successfully:', data);
    showSnackbar(`Bundler "${tokenName}" created successfully`, 'success');
    return data[0];
  } catch (error) {
    return handleDatabaseError(error, 'create bundler');
  }
}

/**
 * Update bundler status
 */
async function updateBundlerStatus(bundlerId, isActive) {
  try {
    if (!supabaseClient) {
      throw new Error('Database not initialized');
    }

    const { data, error } = await supabaseClient
      .from('bundlers')
      .update({ is_active: isActive })
      .eq('id', bundlerId)
      .select();

    if (error) throw error;
    
    const status = isActive ? 'activated' : 'deactivated';
    showSnackbar(`Bundler ${status} successfully`, 'success');
    return data[0];
  } catch (error) {
    return handleDatabaseError(error, 'update bundler status');
  }
}

// ========== MOTHER WALLET OPERATIONS ==========

/**
 * Get all mother wallets with availability status
 */
async function getMotherWallets(filter = 'all') {
  try {
    if (!supabaseClient) {
      throw new Error('Database not initialized');
    }

    let query = supabaseClient
      .from('mother_wallets')
      .select('*')
      .order('id', { ascending: false });

    // Apply filter
    if (filter === 'available') {
      query = query.eq('is_available', true);
    } else if (filter === 'assigned') {
      query = query.eq('is_available', false);
    }

    const { data, error } = await query;

    if (error) throw error;
    
    return data || [];
  } catch (error) {
    return handleDatabaseError(error, 'get mother wallets') || [];
  }
}

/**
 * Create a new mother wallet
 */
async function createMotherWallet(privateKey, publicKey, initialSolBalance = 0) {
  try {
    if (!supabaseClient) {
      throw new Error('Database not initialized');
    }

    const { data, error } = await supabaseClient
      .from('mother_wallets')
      .insert({
        private_key: privateKey,
        public_key: publicKey,
        balance_sol: initialSolBalance,
        is_available: true
      })
      .select();

    if (error) throw error;
    
    console.log('✅ Mother wallet created successfully:', data);
    showSnackbar('Mother wallet created successfully', 'success');
    return data[0];
  } catch (error) {
    return handleDatabaseError(error, 'create mother wallet');
  }
}

// ========== CHILD WALLET OPERATIONS ==========

/**
 * Get child wallets for a specific mother wallet
 */
async function getChildWallets(motherWalletId) {
  try {
    if (!supabaseClient) {
      throw new Error('Database not initialized');
    }

    const { data, error } = await supabaseClient
      .from('child_wallets')
      .select('*')
      .eq('mother_wallet_id', motherWalletId)
      .order('balance_sol', { ascending: false });

    if (error) throw error;
    
    return data || [];
  } catch (error) {
    return handleDatabaseError(error, 'get child wallets') || [];
  }
}

/**
 * Create a new child wallet
 */
async function createChildWallet(privateKey, publicKey, motherWalletId, solBalance = 0, splBalance = 0) {
  try {
    if (!supabaseClient) {
      throw new Error('Database not initialized');
    }

    const { data, error } = await supabaseClient
      .from('child_wallets')
      .insert({
        private_key: privateKey,
        public_key: publicKey,
        mother_wallet_id: motherWalletId,
        balance_sol: solBalance,
        balance_spl: splBalance
      })
      .select();

    if (error) throw error;
    
    console.log('✅ Child wallet created successfully:', data);
    return data[0];
  } catch (error) {
    return handleDatabaseError(error, 'create child wallet');
  }
}

/**
 * Update child wallet balances
 */
async function updateChildWalletBalances(privateKey, solBalance, splBalance) {
  try {
    if (!supabaseClient) {
      throw new Error('Database not initialized');
    }

    const { data, error } = await supabaseClient
      .from('child_wallets')
      .update({
        balance_sol: solBalance,
        balance_spl: splBalance
      })
      .eq('private_key', privateKey)
      .select();

    if (error) throw error;
    
    return data[0];
  } catch (error) {
    return handleDatabaseError(error, 'update child wallet balances');
  }
}

// ========== ASSIGNED MOTHER WALLETS OPERATIONS ==========

/**
 * Get assigned mother wallets for a bundler
 */
async function getAssignedMotherWallets(bundlerId) {
  try {
    if (!supabaseClient) {
      throw new Error('Database not initialized');
    }

    const { data, error } = await supabaseClient
      .from('assigned_mother_wallets')
      .select(`
        *,
        mother_wallets!inner(
          id,
          public_key,
          balance_sol,
          is_available
        )
      `)
      .eq('bundler_id', bundlerId);

    if (error) throw error;
    
    return data || [];
  } catch (error) {
    return handleDatabaseError(error, 'get assigned mother wallets') || [];
  }
}

/**
 * Assign a mother wallet to a bundler
 */
async function assignMotherWalletToBundler(motherWalletId, bundlerId) {
  try {
    if (!supabaseClient) {
      throw new Error('Database not initialized');
    }

    const { data, error } = await supabaseClient
      .from('assigned_mother_wallets')
      .insert({
        mother_wallet_id: motherWalletId,
        bundler_id: bundlerId,
        child_balance_sol: 0,
        child_balance_spl: 0
      })
      .select();

    if (error) throw error;
    
    console.log('✅ Mother wallet assigned to bundler successfully:', data);
    showSnackbar('Mother wallet assigned successfully', 'success');
    return data[0];
  } catch (error) {
    return handleDatabaseError(error, 'assign mother wallet to bundler');
  }
}

// ========== TOKEN OPERATIONS ==========

/**
 * Get all tokens for a user
 */
async function getUserTokens(walletId) {
  try {
    if (!supabaseClient) {
      throw new Error('Database not initialized');
    }

    const { data, error } = await supabaseClient
      .from('tokens')
      .select('*')
      .eq('user_wallet_id', walletId)
      .order('id', { ascending: false });

    if (error) throw error;
    
    return data || [];
  } catch (error) {
    return handleDatabaseError(error, 'get user tokens') || [];
  }
}

/**
 * Create a new token
 */
async function createToken(walletId, tokenData) {
  try {
    if (!supabaseClient) {
      throw new Error('Database not initialized');
    }

    const { data, error } = await supabaseClient
      .from('tokens')
      .insert({
        user_wallet_id: walletId,
        name: tokenData.name,
        symbol: tokenData.symbol,
        description: tokenData.description || null,
        image_url: tokenData.image_url || null,
        twitter: tokenData.twitter || null,
        telegram: tokenData.telegram || null,
        website: tokenData.website || null,
        dev_buy_amount: tokenData.dev_buy_amount || 0,
        contract_address: tokenData.contract_address || null
      })
      .select();

    if (error) throw error;
    
    console.log('✅ Token created successfully:', data);
    showSnackbar(`Token "${tokenData.name}" created successfully`, 'success');
    return data[0];
  } catch (error) {
    return handleDatabaseError(error, 'create token');
  }
}

// ========== ANALYTICS & DASHBOARD DATA ==========

/**
 * Get dashboard summary data for a user
 */
async function getDashboardSummary(walletId) {
  try {
    if (!supabaseClient) {
      throw new Error('Database not initialized');
    }

    // Get user data
    const user = await getUserByWalletId(walletId);
    if (!user) throw new Error('User not found');

    // Get bundlers count and totals
    const bundlers = await getUserBundlers(walletId);
    
    // Get tokens count
    const tokens = await getUserTokens(walletId);

    // Calculate totals
    const totalSolBalance = bundlers.reduce((sum, bundler) => sum + parseFloat(bundler.total_balance_sol || 0), 0);
    const totalSplBalance = bundlers.reduce((sum, bundler) => sum + parseFloat(bundler.total_balance_spl || 0), 0);

    return {
      user,
      bundlers: {
        count: bundlers.length,
        active: bundlers.filter(b => b.is_active).length,
        totalSol: totalSolBalance,
        totalSpl: totalSplBalance
      },
      tokens: {
        count: tokens.length
      }
    };
  } catch (error) {
    return handleDatabaseError(error, 'get dashboard summary');
  }
}

// ========== REAL-TIME SUBSCRIPTIONS ==========

/**
 * Subscribe to bundler changes for real-time updates
 */
function subscribeToBundlerChanges(walletId, callback) {
  if (!supabaseClient) {
    console.error('Database not initialized');
    return null;
  }

  const subscription = supabaseClient
    .channel('bundler-changes')
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'bundlers',
        filter: `user_wallet_id=eq.${walletId}`
      },
      callback
    )
    .subscribe();

  return subscription;
}

/**
 * Subscribe to mother wallet availability changes
 */
function subscribeToMotherWalletChanges(callback) {
  if (!supabaseClient) {
    console.error('Database not initialized');
    return null;
  }

  const subscription = supabaseClient
    .channel('mother-wallet-changes')
    .on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'mother_wallets'
      },
      callback
    )
    .subscribe();

  return subscription;
}

// ========== EXPORT FOR GLOBAL ACCESS ==========

// Make functions globally available
window.DatabaseAPI = {
  // Initialization
  initialize: initializeDatabase,
  
  // User operations
  getUserByWalletId,
  updateUserDistributorBalances,
  updateUserDevBalances,
  updateUserBalances,
  
  // Bundler operations
  getUserBundlers,
  createBundler,
  updateBundlerStatus,
  
  // Mother wallet operations
  getMotherWallets,
  createMotherWallet,
  
  // Child wallet operations
  getChildWallets,
  createChildWallet,
  updateChildWalletBalances,
  
  // Assignment operations
  getAssignedMotherWallets,
  assignMotherWalletToBundler,
  
  // Token operations
  getUserTokens,
  createToken,
  
  // Dashboard
  getDashboardSummary,
  
  // Real-time subscriptions
  subscribeToBundlerChanges,
  subscribeToMotherWalletChanges,
  
  // Utilities
  formatBalance,
  truncateAddress
};

console.log('📦 Database API loaded successfully');

// Auto-initialize if Supabase credentials are provided
if (SUPABASE_URL !== 'YOUR_SUPABASE_URL' && SUPABASE_ANON_KEY !== 'YOUR_SUPABASE_ANON_KEY') {
  // Wait for DOM to be ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeDatabase);
  } else {
    initializeDatabase();
  }
}
