const { supabase } = require('../config/database');
const logger = require('../utils/logger');
const { AppError } = require('../middleware/errorHandler');

class TokenModel {
  /**
   * Create a new token record
   * @param {Object} tokenData - Token information
   * @param {string} tokenData.name - Token name
   * @param {string} tokenData.symbol - Token symbol
   * @param {string} tokenData.description - Token description
   * @param {string} tokenData.imageUrl - Token image URL
   * @param {string} tokenData.twitter - Twitter handle
   * @param {string} tokenData.telegram - Telegram handle
   * @param {string} tokenData.website - Website URL
   * @param {number} tokenData.devBuyAmount - Developer buy amount
   * @param {string} tokenData.contractAddress - Token contract address
   * @param {string} tokenData.userWalletId - Creator's wallet ID
   * @returns {Promise<Object>} Created token record
   */
  async createToken(tokenData) {
    try {
      const { data, error } = await supabase
        .from('tokens')
        .insert({
          name: tokenData.name,
          symbol: tokenData.symbol,
          description: tokenData.description,
          image_url: tokenData.imageUrl,
          twitter: tokenData.twitter,
          telegram: tokenData.telegram,
          website: tokenData.website,
          dev_buy_amount: tokenData.devBuyAmount,
          contract_address: tokenData.contractAddress,
          user_wallet_id: tokenData.userWalletId
        })
        .select()
        .single();

      if (error) {
        if (error.code === '23505') { // Unique constraint violation
          throw new AppError('Token with this symbol or contract address already exists', 409, 'TOKEN_ALREADY_EXISTS');
        }
        throw error;
      }

      logger.info('Token created successfully', {
        name: tokenData.name,
        symbol: tokenData.symbol,
        contractAddress: tokenData.contractAddress,
        userWalletId: tokenData.userWalletId
      });

      return data;
    } catch (error) {
      logger.error('Error creating token:', {
        symbol: tokenData.symbol,
        error: error.message
      });
      
      if (error instanceof AppError) {
        throw error;
      }
      
      throw new AppError('Failed to create token', 500, 'TOKEN_CREATION_FAILED');
    }
  }

  /**
   * Get token by contract address
   * @param {string} contractAddress - Token contract address
   * @returns {Promise<Object|null>} Token record or null
   */
  async getTokenByContract(contractAddress) {
    try {
      const { data, error } = await supabase
        .from('tokens')
        .select('*')
        .eq('contract_address', contractAddress)
        .single();

      if (error && error.code !== 'PGRST116') { // PGRST116 = no rows returned
        throw error;
      }

      return data;
    } catch (error) {
      logger.error('Error getting token by contract:', { contractAddress, error: error.message });
      throw new AppError('Failed to get token', 500, 'TOKEN_FETCH_FAILED');
    }
  }

  /**
   * Get token by symbol
   * @param {string} symbol - Token symbol
   * @returns {Promise<Object|null>} Token record or null
   */
  async getTokenBySymbol(symbol) {
    try {
      const { data, error } = await supabase
        .from('tokens')
        .select('*')
        .eq('symbol', symbol)
        .single();

      if (error && error.code !== 'PGRST116') { // PGRST116 = no rows returned
        throw error;
      }

      return data;
    } catch (error) {
      logger.error('Error getting token by symbol:', { symbol, error: error.message });
      throw new AppError('Failed to get token', 500, 'TOKEN_FETCH_FAILED');
    }
  }

  /**
   * Get tokens created by a user
   * @param {string} userWalletId - User's wallet ID
   * @returns {Promise<Array>} Array of token records
   */
  async getTokensByUser(userWalletId) {
    try {
      const { data, error } = await supabase
        .from('tokens')
        .select('*')
        .eq('user_wallet_id', userWalletId)
        .order('id', { ascending: false });

      if (error) {
        throw error;
      }

      return data;
    } catch (error) {
      logger.error('Error getting tokens by user:', { userWalletId, error: error.message });
      throw new AppError('Failed to get user tokens', 500, 'USER_TOKENS_FETCH_FAILED');
    }
  }

  /**
   * Get the most recent token created by a user
   * @param {string} userWalletId - User's wallet ID
   * @returns {Promise<Object|null>} Most recent token or null
   */
  async getLatestTokenByUser(userWalletId) {
    try {
      const { data, error } = await supabase
        .from('tokens')
        .select('*')
        .eq('user_wallet_id', userWalletId)
        .order('id', { ascending: false })
        .limit(1)
        .single();

      if (error && error.code !== 'PGRST116') { // PGRST116 = no rows returned
        throw error;
      }

      return data;
    } catch (error) {
      logger.error('Error getting latest token by user:', { userWalletId, error: error.message });
      throw new AppError('Failed to get latest token', 500, 'LATEST_TOKEN_FETCH_FAILED');
    }
  }

  /**
   * Update token information
   * @param {string} contractAddress - Token contract address
   * @param {Object} updates - Fields to update
   * @returns {Promise<Object>} Updated token record
   */
  async updateToken(contractAddress, updates) {
    try {
      const { data, error } = await supabase
        .from('tokens')
        .update(updates)
        .eq('contract_address', contractAddress)
        .select()
        .single();

      if (error) {
        throw error;
      }

      logger.info('Token updated successfully', { contractAddress, updates });
      return data;
    } catch (error) {
      logger.error('Error updating token:', { contractAddress, error: error.message });
      throw new AppError('Failed to update token', 500, 'TOKEN_UPDATE_FAILED');
    }
  }

  /**
   * Delete token by contract address
   * @param {string} contractAddress - Token contract address
   * @returns {Promise<boolean>} True if deleted successfully
   */
  async deleteToken(contractAddress) {
    try {
      const { error } = await supabase
        .from('tokens')
        .delete()
        .eq('contract_address', contractAddress);

      if (error) {
        throw error;
      }

      logger.info('Token deleted successfully', { contractAddress });
      return true;
    } catch (error) {
      logger.error('Error deleting token:', { contractAddress, error: error.message });
      throw new AppError('Failed to delete token', 500, 'TOKEN_DELETION_FAILED');
    }
  }

  /**
   * Check if token symbol is available
   * @param {string} symbol - Token symbol to check
   * @returns {Promise<boolean>} True if symbol is available
   */
  async isSymbolAvailable(symbol) {
    try {
      const token = await this.getTokenBySymbol(symbol);
      return token === null;
    } catch (error) {
      if (error.code === 'TOKEN_FETCH_FAILED') {
        // If we can't fetch, assume it's not available for safety
        return false;
      }
      throw error;
    }
  }

  /**
   * Get token statistics
   * @param {string} userWalletId - User's wallet ID (optional)
   * @returns {Promise<Object>} Token statistics
   */
  async getTokenStats(userWalletId = null) {
    try {
      let query = supabase
        .from('tokens')
        .select('id, dev_buy_amount');

      if (userWalletId) {
        query = query.eq('user_wallet_id', userWalletId);
      }

      const { data, error } = await query;

      if (error) {
        throw error;
      }

      const stats = {
        total_tokens: data.length,
        total_dev_buy_amount: data.reduce((sum, token) => sum + parseFloat(token.dev_buy_amount || 0), 0)
      };

      return stats;
    } catch (error) {
      logger.error('Error getting token stats:', { userWalletId, error: error.message });
      throw new AppError('Failed to get token statistics', 500, 'TOKEN_STATS_FAILED');
    }
  }
}

module.exports = new TokenModel();
