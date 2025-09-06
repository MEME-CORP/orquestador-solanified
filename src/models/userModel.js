const { supabase, pgPool } = require('../config/database');
const logger = require('../utils/logger');
const { AppError } = require('../middleware/errorHandler');

class UserModel {
  /**
   * Create or get user by wallet ID
   * @param {string} userWalletId - User's connected wallet address
   * @param {string} inAppPrivateKey - Generated in-app private key
   * @param {string} inAppPublicKey - Generated in-app public key
   * @returns {Promise<Object>} User record
   */
  async createUser(userWalletId, inAppPrivateKey, inAppPublicKey) {
    const dbOperationStart = Date.now();
    
    try {
      logger.info('💾 [USER_MODEL] Initiating user creation in database', {
        userWalletId,
        inAppPublicKey,
        has_private_key: !!inAppPrivateKey,
        private_key_length: inAppPrivateKey ? inAppPrivateKey.length : 0,
        public_key_length: inAppPublicKey ? inAppPublicKey.length : 0
      });

      const { data, error } = await supabase
        .from('users')
        .insert({
          user_wallet_id: userWalletId,
          in_app_private_key: inAppPrivateKey,
          in_app_public_key: inAppPublicKey,
          balance_sol: 0,
          balance_spl: 0
        })
        .select()
        .single();

      const dbOperationTime = Date.now() - dbOperationStart;

      if (error) {
        logger.error('❌ [USER_MODEL] Database error during user creation', {
          userWalletId,
          inAppPublicKey,
          db_operation_time_ms: dbOperationTime,
          error_code: error.code,
          error_message: error.message,
          error_details: error.details,
          error_hint: error.hint
        });

        if (error.code === '23505') { // Unique constraint violation
          logger.warn('⚠️ [USER_MODEL] Duplicate user creation attempt', {
            userWalletId,
            inAppPublicKey,
            constraint_violation: 'Primary key constraint on user_wallet_id'
          });
          throw new AppError('User already exists', 409, 'USER_ALREADY_EXISTS');
        }
        throw error;
      }

      logger.info('✅ [USER_MODEL] User created successfully in database', {
        userWalletId,
        inAppPublicKey,
        db_operation_time_ms: dbOperationTime,
        user_id: data.id,
        initial_sol_balance: data.balance_sol,
        initial_spl_balance: data.balance_spl,
        created_at: data.created_at || new Date().toISOString()
      });

      return data;
    } catch (error) {
      const dbOperationTime = Date.now() - dbOperationStart;
      
      logger.error('❌ [USER_MODEL] Failed to create user', {
        userWalletId,
        inAppPublicKey,
        db_operation_time_ms: dbOperationTime,
        error_message: error.message,
        error_code: error.code,
        error_type: error.constructor.name,
        is_app_error: error instanceof AppError
      });
      
      if (error instanceof AppError) {
        throw error;
      }
      
      throw new AppError('Failed to create user', 500, 'USER_CREATION_FAILED');
    }
  }

  /**
   * Get user by wallet ID
   * @param {string} userWalletId - User's wallet ID
   * @returns {Promise<Object|null>} User record or null if not found
   */
  async getUserByWalletId(userWalletId) {
    try {
      const { data, error } = await supabase
        .from('users')
        .select('*')
        .eq('user_wallet_id', userWalletId)
        .single();

      if (error && error.code !== 'PGRST116') { // PGRST116 = no rows returned
        throw error;
      }

      return data;
    } catch (error) {
      logger.error('Error getting user:', { userWalletId, error: error.message });
      throw new AppError('Failed to get user', 500, 'USER_FETCH_FAILED');
    }
  }

  /**
   * Update user SOL balance
   * @param {string} userWalletId - User's wallet ID
   * @param {number} balanceSol - New SOL balance
   * @returns {Promise<Object>} Updated user record
   */
  async updateSolBalance(userWalletId, balanceSol) {
    try {
      const { data, error } = await supabase
        .from('users')
        .update({ balance_sol: balanceSol })
        .eq('user_wallet_id', userWalletId)
        .select()
        .single();

      if (error) {
        throw error;
      }

      logger.info('User SOL balance updated', { userWalletId, balanceSol });
      return data;
    } catch (error) {
      logger.error('Error updating user SOL balance:', { userWalletId, error: error.message });
      throw new AppError('Failed to update user SOL balance', 500, 'BALANCE_UPDATE_FAILED');
    }
  }

  /**
   * Update user SPL balance
   * @param {string} userWalletId - User's wallet ID
   * @param {number} balanceSpl - New SPL balance
   * @returns {Promise<Object>} Updated user record
   */
  async updateSplBalance(userWalletId, balanceSpl) {
    try {
      const { data, error } = await supabase
        .from('users')
        .update({ balance_spl: balanceSpl })
        .eq('user_wallet_id', userWalletId)
        .select()
        .single();

      if (error) {
        throw error;
      }

      logger.info('User SPL balance updated', { userWalletId, balanceSpl });
      return data;
    } catch (error) {
      logger.error('Error updating user SPL balance:', { userWalletId, error: error.message });
      throw new AppError('Failed to update user SPL balance', 500, 'SPL_BALANCE_UPDATE_FAILED');
    }
  }

  /**
   * Update both SOL and SPL balances
   * @param {string} userWalletId - User's wallet ID
   * @param {number} balanceSol - New SOL balance
   * @param {number} balanceSpl - New SPL balance
   * @returns {Promise<Object>} Updated user record
   */
  async updateBalances(userWalletId, balanceSol, balanceSpl) {
    try {
      const { data, error } = await supabase
        .from('users')
        .update({ 
          balance_sol: balanceSol,
          balance_spl: balanceSpl
        })
        .eq('user_wallet_id', userWalletId)
        .select()
        .single();

      if (error) {
        throw error;
      }

      logger.info('User balances updated', { userWalletId, balanceSol, balanceSpl });
      return data;
    } catch (error) {
      logger.error('Error updating user balances:', { userWalletId, error: error.message });
      throw new AppError('Failed to update user balances', 500, 'BALANCES_UPDATE_FAILED');
    }
  }

  /**
   * Check if user has sufficient SOL balance
   * @param {string} userWalletId - User's wallet ID
   * @param {number} requiredAmount - Required SOL amount
   * @returns {Promise<boolean>} True if user has sufficient balance
   */
  async hasSufficientBalance(userWalletId, requiredAmount) {
    try {
      const user = await this.getUserByWalletId(userWalletId);
      if (!user) {
        throw new AppError('User not found', 404, 'USER_NOT_FOUND');
      }

      return parseFloat(user.balance_sol) >= requiredAmount;
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      
      logger.error('Error checking user balance:', { userWalletId, error: error.message });
      throw new AppError('Failed to check user balance', 500, 'BALANCE_CHECK_FAILED');
    }
  }
}

module.exports = new UserModel();
