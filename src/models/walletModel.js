const { supabase } = require('../config/database');
const logger = require('../utils/logger');
const { AppError } = require('../middleware/errorHandler');

class WalletModel {
  /**
   * Update mother wallet balance
   * @param {number} motherWalletId - Mother wallet ID
   * @param {number} balanceSol - New SOL balance
   * @returns {Promise<Object>} Updated mother wallet
   */
  async updateMotherWalletBalance(motherWalletId, balanceSol) {
    try {
      const { data, error } = await supabase
        .from('mother_wallets')
        .update({ balance_sol: balanceSol })
        .eq('id', motherWalletId)
        .select()
        .single();

      if (error) {
        throw error;
      }

      logger.info('Mother wallet balance updated', { motherWalletId, balanceSol });
      return data;
    } catch (error) {
      logger.error('Error updating mother wallet balance:', { motherWalletId, error: error.message });
      throw new AppError('Failed to update mother wallet balance', 500, 'MOTHER_WALLET_UPDATE_FAILED');
    }
  }

  /**
   * Update child wallet balances
   * @param {string} publicKey - Child wallet public key
   * @param {number} balanceSol - New SOL balance
   * @param {number} balanceSpl - New SPL balance
   * @returns {Promise<Object>} Updated child wallet
   */
  async updateChildWalletBalances(publicKey, balanceSol, balanceSpl) {
    try {
      // First get the current balances for comparison
      const { data: currentData, error: selectError } = await supabase
        .from('child_wallets')
        .select('balance_sol, balance_spl')
        .eq('public_key', publicKey)
        .single();

      if (selectError) {
        throw selectError;
      }

      const previousSolBalance = parseFloat(currentData.balance_sol) || 0;
      const previousSplBalance = parseFloat(currentData.balance_spl) || 0;
      const newSolBalance = parseFloat(balanceSol) || 0;
      const newSplBalance = parseFloat(balanceSpl) || 0;

      // Now update the balances
      const { data, error } = await supabase
        .from('child_wallets')
        .update({ 
          balance_sol: balanceSol,
          balance_spl: balanceSpl
        })
        .eq('public_key', publicKey)
        .select()
        .single();

      if (error) {
        throw error;
      }

      const solChanged = Math.abs(previousSolBalance - newSolBalance) > 0.000001; // 1 microSOL tolerance
      const splChanged = Math.abs(previousSplBalance - newSplBalance) > 0.000001; // Small tolerance for floating point

      logger.info('Child wallet balances updated', { 
        publicKey, 
        balanceSol: newSolBalance, 
        balanceSpl: newSplBalance,
        updateType: 'both_sol_and_spl',
        previousSolBalance,
        previousSplBalance,
        solChanged,
        splChanged,
        solDifference: newSolBalance - previousSolBalance,
        splDifference: newSplBalance - previousSplBalance
      });
      return data;
    } catch (error) {
      logger.error('Error updating child wallet balances:', { publicKey, error: error.message });
      throw new AppError('Failed to update child wallet balances', 500, 'CHILD_WALLET_UPDATE_FAILED');
    }
  }

  /**
   * Update child wallet SOL balance only
   * @param {string} publicKey - Child wallet public key
   * @param {number} balanceSol - New SOL balance
   * @returns {Promise<Object>} Updated child wallet
   */
  async updateChildWalletSolBalance(publicKey, balanceSol) {
    try {
      // First get the current balance for comparison
      const { data: currentData, error: selectError } = await supabase
        .from('child_wallets')
        .select('balance_sol')
        .eq('public_key', publicKey)
        .single();

      if (selectError) {
        throw selectError;
      }

      const previousSolBalance = parseFloat(currentData.balance_sol) || 0;
      const newSolBalance = parseFloat(balanceSol) || 0;

      const { data, error } = await supabase
        .from('child_wallets')
        .update({ balance_sol: balanceSol })
        .eq('public_key', publicKey)
        .select()
        .single();

      if (error) {
        throw error;
      }

      const solChanged = Math.abs(previousSolBalance - newSolBalance) > 0.000001;

      logger.info('Child wallet SOL balance updated', { 
        publicKey, 
        balanceSol: newSolBalance,
        previousSolBalance,
        solChanged,
        solDifference: newSolBalance - previousSolBalance
      });
      return data;
    } catch (error) {
      logger.error('Error updating child wallet SOL balance:', { publicKey, error: error.message });
      throw new AppError('Failed to update child wallet SOL balance', 500, 'CHILD_WALLET_SOL_UPDATE_FAILED');
    }
  }

  /**
   * Update child wallet SPL balance only
   * @param {string} publicKey - Child wallet public key
   * @param {number} balanceSpl - New SPL balance
   * @returns {Promise<Object>} Updated child wallet
   */
  async updateChildWalletSplBalance(publicKey, balanceSpl) {
    try {
      // First get the current balance for comparison
      const { data: currentData, error: selectError } = await supabase
        .from('child_wallets')
        .select('balance_spl')
        .eq('public_key', publicKey)
        .single();

      if (selectError) {
        throw selectError;
      }

      const previousSplBalance = parseFloat(currentData.balance_spl) || 0;
      const newSplBalance = parseFloat(balanceSpl) || 0;

      const { data, error } = await supabase
        .from('child_wallets')
        .update({ balance_spl: balanceSpl })
        .eq('public_key', publicKey)
        .select()
        .single();

      if (error) {
        throw error;
      }

      const splChanged = Math.abs(previousSplBalance - newSplBalance) > 0.000001;

      logger.info('Child wallet SPL balance updated', { 
        publicKey, 
        balanceSpl: newSplBalance,
        previousSplBalance,
        splChanged,
        splDifference: newSplBalance - previousSplBalance
      });
      return data;
    } catch (error) {
      logger.error('Error updating child wallet SPL balance:', { publicKey, error: error.message });
      throw new AppError('Failed to update child wallet SPL balance', 500, 'CHILD_WALLET_SPL_UPDATE_FAILED');
    }
  }

  /**
   * Get child wallets by mother wallet ID
   * @param {number} motherWalletId - Mother wallet ID
   * @returns {Promise<Array>} Array of child wallets
   */
  async getChildWalletsByMother(motherWalletId) {
    try {
      const { data, error } = await supabase
        .from('child_wallets')
        .select('*')
        .eq('mother_wallet_id', motherWalletId)
        .order('public_key');

      if (error) {
        throw error;
      }

      return data;
    } catch (error) {
      logger.error('Error getting child wallets by mother:', { motherWalletId, error: error.message });
      throw new AppError('Failed to get child wallets', 500, 'CHILD_WALLETS_FETCH_FAILED');
    }
  }

  /**
   * Get available mother wallets count
   * @returns {Promise<number>} Number of available mother wallets
   */
  async getAvailableMotherWalletsCount() {
    try {
      const { count, error } = await supabase
        .from('mother_wallets')
        .select('*', { count: 'exact', head: true })
        .eq('is_available', true);

      if (error) {
        throw error;
      }

      return count;
    } catch (error) {
      logger.error('Error getting available mother wallets count:', error.message);
      throw new AppError('Failed to get available mother wallets count', 500, 'MOTHER_WALLETS_COUNT_FAILED');
    }
  }

  /**
   * Update multiple child wallet balances efficiently
   * @param {Array} updates - Array of {publicKey, balanceSol?, balanceSpl?} objects
   * @returns {Promise<Array>} Array of update results
   */
  async batchUpdateChildWallets(updates) {
    try {
      const updatePromises = updates.map(async (update) => {
        const updateData = {};
        if (update.balanceSol !== undefined) updateData.balance_sol = update.balanceSol;
        if (update.balanceSpl !== undefined) updateData.balance_spl = update.balanceSpl;

        const { data, error } = await supabase
          .from('child_wallets')
          .update(updateData)
          .eq('public_key', update.publicKey)
          .select()
          .single();

        if (error) {
          logger.error('Error in batch update for child wallet:', { 
            publicKey: update.publicKey, 
            error: error.message 
          });
          return { publicKey: update.publicKey, success: false, error: error.message };
        }

        return { publicKey: update.publicKey, success: true, data };
      });

      const results = await Promise.all(updatePromises);
      
      const successful = results.filter(r => r.success).length;
      const failed = results.filter(r => !r.success).length;

      logger.info('Batch update child wallets completed', { 
        total: updates.length, 
        successful, 
        failed 
      });

      return results;
    } catch (error) {
      logger.error('Error in batch update child wallets:', error.message);
      throw new AppError('Failed to batch update child wallets', 500, 'BATCH_UPDATE_FAILED');
    }
  }

  /**
   * Get child wallet SPL balance
   * @param {string} publicKey - Child wallet public key
   * @returns {Promise<number>} Current SPL balance
   */
  async getChildWalletSplBalance(publicKey) {
    try {
      const { data, error } = await supabase
        .from('child_wallets')
        .select('balance_spl')
        .eq('public_key', publicKey)
        .single();

      if (error) {
        throw error;
      }

      return parseFloat(data.balance_spl) || 0;
    } catch (error) {
      logger.error('Error getting child wallet SPL balance:', { publicKey, error: error.message });
      throw new AppError('Failed to get child wallet SPL balance', 500, 'CHILD_WALLET_SPL_FETCH_FAILED');
    }
  }

  /**
   * Get wallet by public key (works for both mother and child wallets)
   * @param {string} publicKey - Wallet public key
   * @returns {Promise<Object|null>} Wallet object or null
   */
  async getWalletByPublicKey(publicKey) {
    try {
      // Try mother wallets first
      const { data: motherWallet, error: motherError } = await supabase
        .from('mother_wallets')
        .select('*, \'mother\' as wallet_type')
        .eq('public_key', publicKey)
        .single();

      if (motherWallet && !motherError) {
        return motherWallet;
      }

      // Try child wallets
      const { data: childWallet, error: childError } = await supabase
        .from('child_wallets')
        .select('*, \'child\' as wallet_type')
        .eq('public_key', publicKey)
        .single();

      if (childWallet && !childError) {
        return childWallet;
      }

      return null;
    } catch (error) {
      logger.error('Error getting wallet by public key:', { publicKey, error: error.message });
      throw new AppError('Failed to get wallet', 500, 'WALLET_FETCH_FAILED');
    }
  }
}

module.exports = new WalletModel();
