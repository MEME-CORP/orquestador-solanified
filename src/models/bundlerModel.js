const { supabase, pgPool } = require('../config/database');
const logger = require('../utils/logger');
const { AppError } = require('../middleware/errorHandler');

class BundlerModel {
  /**
   * Create a new bundler and assign mother wallets atomically
   * @param {string} userWalletId - User's wallet ID
   * @param {number} motherWalletCount - Number of mother wallets to assign
   * @returns {Promise<Object>} Created bundler with assigned mother wallets
   */
  async createBundlerWithMotherWallets(userWalletId, motherWalletCount) {
    const client = await pgPool.connect();
    
    try {
      await client.query('BEGIN');

      // Select and lock available mother wallets
      const motherWalletsQuery = `
        SELECT id, public_key, private_key
        FROM mother_wallets
        WHERE is_available = TRUE
        ORDER BY id
        FOR UPDATE SKIP LOCKED
        LIMIT $1
      `;
      
      const motherWalletsResult = await client.query(motherWalletsQuery, [motherWalletCount]);
      
      if (motherWalletsResult.rows.length < motherWalletCount) {
        throw new AppError(
          `Only ${motherWalletsResult.rows.length} mother wallets available, need ${motherWalletCount}`,
          409,
          'INSUFFICIENT_MOTHER_WALLETS'
        );
      }

      // Create bundler
      const bundlerQuery = `
        INSERT INTO bundlers (user_wallet_id, is_active, token_name)
        VALUES ($1, TRUE, NULL)
        RETURNING id
      `;
      
      const bundlerResult = await client.query(bundlerQuery, [userWalletId]);
      const bundlerId = bundlerResult.rows[0].id;

      // Assign mother wallets to bundler
      const assignmentPromises = motherWalletsResult.rows.map(wallet => {
        const assignQuery = `
          INSERT INTO assigned_mother_wallets (mother_wallet_id, bundler_id)
          VALUES ($1, $2)
        `;
        return client.query(assignQuery, [wallet.id, bundlerId]);
      });

      await Promise.all(assignmentPromises);

      await client.query('COMMIT');

      logger.info('Bundler created with mother wallets', {
        bundlerId,
        userWalletId,
        motherWalletsAssigned: motherWalletsResult.rows.length
      });

      return {
        bundler_id: bundlerId,
        allocated_mother_wallets: motherWalletsResult.rows.map(wallet => ({
          id: wallet.id,
          public_key: wallet.public_key,
          private_key: wallet.private_key
        }))
      };
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Error creating bundler with mother wallets:', {
        userWalletId,
        motherWalletCount,
        error: error.message
      });
      
      if (error instanceof AppError) {
        throw error;
      }
      
      throw new AppError('Failed to create bundler', 500, 'BUNDLER_CREATION_FAILED');
    } finally {
      client.release();
    }
  }

  /**
   * Get the most recent active bundler for a user
   * @param {string} userWalletId - User's wallet ID
   * @returns {Promise<Object|null>} Bundler record or null
   */
  async getLatestActiveBundler(userWalletId) {
    try {
      const { data, error } = await supabase
        .from('bundlers')
        .select('*')
        .eq('user_wallet_id', userWalletId)
        .eq('is_active', true)
        .order('id', { ascending: false })
        .limit(1)
        .single();

      if (error && error.code !== 'PGRST116') { // PGRST116 = no rows returned
        throw error;
      }

      return data;
    } catch (error) {
      logger.error('Error getting latest active bundler:', { userWalletId, error: error.message });
      throw new AppError('Failed to get active bundler', 500, 'BUNDLER_FETCH_FAILED');
    }
  }

  /**
   * Update bundler token name
   * @param {number} bundlerId - Bundler ID
   * @param {string} tokenName - Token name/symbol
   * @returns {Promise<Object>} Updated bundler
   */
  async updateTokenName(bundlerId, tokenName) {
    try {
      const { data, error } = await supabase
        .from('bundlers')
        .update({ token_name: tokenName })
        .eq('id', bundlerId)
        .select()
        .single();

      if (error) {
        throw error;
      }

      logger.info('Bundler token name updated', { bundlerId, tokenName });
      return data;
    } catch (error) {
      logger.error('Error updating bundler token name:', { bundlerId, error: error.message });
      throw new AppError('Failed to update bundler token name', 500, 'BUNDLER_UPDATE_FAILED');
    }
  }

  /**
   * Deactivate bundler
   * @param {number} bundlerId - Bundler ID
   * @returns {Promise<Object>} Updated bundler
   */
  async deactivateBundler(bundlerId) {
    try {
      const { data, error } = await supabase
        .from('bundlers')
        .update({ is_active: false })
        .eq('id', bundlerId)
        .select()
        .single();

      if (error) {
        throw error;
      }

      logger.info('Bundler deactivated', { bundlerId });
      return data;
    } catch (error) {
      logger.error('Error deactivating bundler:', { bundlerId, error: error.message });
      throw new AppError('Failed to deactivate bundler', 500, 'BUNDLER_DEACTIVATION_FAILED');
    }
  }

  /**
   * Get bundler with assigned mother wallets and their children
   * @param {number} bundlerId - Bundler ID
   * @returns {Promise<Object>} Bundler with full wallet hierarchy
   */
  async getBundlerWithWallets(bundlerId) {
    try {
      // Get bundler info
      const { data: bundler, error: bundlerError } = await supabase
        .from('bundlers')
        .select('*')
        .eq('id', bundlerId)
        .single();

      if (bundlerError) {
        throw bundlerError;
      }

      // Get assigned mother wallets with their children
      const { data: assignments, error: assignmentError } = await supabase
        .from('assigned_mother_wallets')
        .select(`
          mother_wallet_id,
          child_balance_sol,
          child_balance_spl,
          mother_wallets!inner (
            id,
            public_key,
            private_key,
            balance_sol
          )
        `)
        .eq('bundler_id', bundlerId);

      if (assignmentError) {
        throw assignmentError;
      }

      // Get child wallets for each mother wallet
      const motherWalletIds = assignments.map(a => a.mother_wallet_id);
      const { data: childWallets, error: childError } = await supabase
        .from('child_wallets')
        .select('*')
        .in('mother_wallet_id', motherWalletIds);

      if (childError) {
        throw childError;
      }

      // Organize child wallets by mother wallet
      const childWalletsByMother = childWallets.reduce((acc, child) => {
        if (!acc[child.mother_wallet_id]) {
          acc[child.mother_wallet_id] = [];
        }
        acc[child.mother_wallet_id].push(child);
        return acc;
      }, {});

      // Combine data
      const motherWalletsWithChildren = assignments.map(assignment => ({
        ...assignment.mother_wallets,
        child_balance_sol: assignment.child_balance_sol,
        child_balance_spl: assignment.child_balance_spl,
        child_wallets: childWalletsByMother[assignment.mother_wallet_id] || []
      }));

      return {
        ...bundler,
        mother_wallets: motherWalletsWithChildren
      };
    } catch (error) {
      logger.error('Error getting bundler with wallets:', { bundlerId, error: error.message });
      throw new AppError('Failed to get bundler with wallets', 500, 'BUNDLER_WALLETS_FETCH_FAILED');
    }
  }

  /**
   * Get all child wallets for a bundler
   * @param {number} bundlerId - Bundler ID
   * @returns {Promise<Array>} Array of child wallet objects
   */
  async getChildWallets(bundlerId) {
    try {
      const { data, error } = await supabase
        .from('child_wallets')
        .select(`
          *,
          mother_wallets!inner (
            assigned_mother_wallets!inner (
              bundler_id
            )
          )
        `)
        .eq('mother_wallets.assigned_mother_wallets.bundler_id', bundlerId);

      if (error) {
        throw error;
      }

      return data;
    } catch (error) {
      logger.error('Error getting child wallets for bundler:', { bundlerId, error: error.message });
      throw new AppError('Failed to get child wallets', 500, 'CHILD_WALLETS_FETCH_FAILED');
    }
  }
}

module.exports = new BundlerModel();
