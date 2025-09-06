const logger = require('./logger');

/**
 * Utility class to validate API responses match expected structure
 */
class ApiResponseValidator {
  /**
   * Validate wallet creation response
   * @param {Object} response - API response
   * @returns {boolean} True if valid
   */
  static validateWalletCreateResponse(response) {
    try {
      if (!response.ok || !Array.isArray(response.data)) {
        logger.error('Invalid wallet create response structure', { response });
        return false;
      }

      for (const wallet of response.data) {
        if (!wallet.publicKey || !wallet.privateKey) {
          logger.error('Wallet missing required fields', { wallet });
          return false;
        }
      }

      return true;
    } catch (error) {
      logger.error('Error validating wallet create response', { error: error.message });
      return false;
    }
  }

  /**
   * Validate SOL balance response
   * @param {Object} response - API response
   * @returns {boolean} True if valid
   */
  static validateSolBalanceResponse(response) {
    try {
      if (!response.ok || !response.data) {
        logger.error('Invalid SOL balance response structure', { response });
        return false;
      }

      const { publicKey, balanceSol, balanceLamports } = response.data;
      
      if (!publicKey || typeof balanceSol !== 'number' || typeof balanceLamports !== 'string') {
        logger.error('SOL balance response missing required fields or wrong types', { 
          publicKey, 
          balanceSol: typeof balanceSol, 
          balanceLamports: typeof balanceLamports 
        });
        return false;
      }

      return true;
    } catch (error) {
      logger.error('Error validating SOL balance response', { error: error.message });
      return false;
    }
  }

  /**
   * Validate SOL transfer response
   * @param {Object} response - API response
   * @returns {boolean} True if valid
   */
  static validateSolTransferResponse(response) {
    try {
      if (!response.ok || !response.data) {
        logger.error('Invalid SOL transfer response structure', { response });
        return false;
      }

      const { signature, confirmed, preBalances, postBalances, transfer } = response.data;
      
      if (!signature || typeof confirmed !== 'boolean') {
        logger.error('SOL transfer response missing signature or confirmed field', { signature, confirmed });
        return false;
      }

      // Validate balance structures
      if (!preBalances?.fromSol || !preBalances?.toSol || 
          !postBalances?.fromSol || !postBalances?.toSol) {
        logger.error('SOL transfer response missing balance information', { preBalances, postBalances });
        return false;
      }

      return true;
    } catch (error) {
      logger.error('Error validating SOL transfer response', { error: error.message });
      return false;
    }
  }

  /**
   * Validate Pump.fun token creation response
   * @param {Object} response - API response
   * @returns {boolean} True if valid
   */
  static validatePumpCreateResponse(response) {
    try {
      if (!response.ok || !response.data) {
        logger.error('Invalid Pump create response structure', { response });
        return false;
      }

      const { signature, confirmed, postBalances } = response.data;
      
      if (!signature || typeof confirmed !== 'boolean') {
        logger.error('Pump create response missing signature or confirmed field', { signature, confirmed });
        return false;
      }

      // Check for contract address in postBalances.spl.mintAddress or generatedMint.publicKey
      const mintAddress = postBalances?.spl?.mintAddress || response.data.generatedMint?.publicKey;
      if (!mintAddress) {
        logger.error('Pump create response missing mint address', { 
          postBalancesSpl: postBalances?.spl,
          generatedMint: response.data.generatedMint
        });
        return false;
      }

      // Validate balance structures
      if (!postBalances?.sol?.balanceSol || !postBalances?.spl?.uiAmount) {
        logger.error('Pump create response missing post-balance information', { postBalances });
        return false;
      }

      return true;
    } catch (error) {
      logger.error('Error validating Pump create response', { error: error.message });
      return false;
    }
  }

  /**
   * Validate Pump.fun buy/sell response
   * @param {Object} response - API response
   * @returns {boolean} True if valid
   */
  static validatePumpTradeResponse(response) {
    try {
      if (!response.ok || !response.data) {
        logger.error('Invalid Pump trade response structure', { response });
        return false;
      }

      const { signature, confirmed, postBalances } = response.data;
      
      if (!signature || typeof confirmed !== 'boolean') {
        logger.error('Pump trade response missing signature or confirmed field', { signature, confirmed });
        return false;
      }

      // Validate balance structures
      if (!postBalances?.sol?.balanceSol || 
          postBalances?.spl?.uiAmount === undefined) { // uiAmount can be 0
        logger.error('Pump trade response missing post-balance information', { postBalances });
        return false;
      }

      return true;
    } catch (error) {
      logger.error('Error validating Pump trade response', { error: error.message });
      return false;
    }
  }

  /**
   * Validate Pinata upload response
   * @param {Object} response - API response
   * @returns {boolean} True if valid
   */
  static validateUploadResponse(response) {
    try {
      if (!response.ok || !response.data) {
        logger.error('Invalid upload response structure', { response });
        return false;
      }

      const { cid, gatewayUrl, fileName, contentType } = response.data;
      
      if (!cid || !gatewayUrl || !fileName || !contentType) {
        logger.error('Upload response missing required fields', { cid, gatewayUrl, fileName, contentType });
        return false;
      }

      return true;
    } catch (error) {
      logger.error('Error validating upload response', { error: error.message });
      return false;
    }
  }

  /**
   * Extract contract address from token creation response
   * @param {Object} response - Pump.fun create response
   * @returns {string|null} Contract address or null
   */
  static extractContractAddress(response) {
    try {
      // Priority: postBalances.spl.mintAddress > generatedMint.publicKey
      return response.data?.postBalances?.spl?.mintAddress || 
             response.data?.generatedMint?.publicKey || 
             null;
    } catch (error) {
      logger.error('Error extracting contract address', { error: error.message });
      return null;
    }
  }

  /**
   * Extract balance information from trade response
   * @param {Object} response - Pump.fun trade response
   * @returns {Object} Balance information
   */
  static extractTradeBalances(response) {
    try {
      return {
        solBalance: response.data?.postBalances?.sol?.balanceSol || 0,
        splBalance: response.data?.postBalances?.spl?.uiAmount || 0,
        publicKey: response.data?.postBalances?.sol?.publicKey || 
                   response.data?.postBalances?.spl?.walletPublicKey || null
      };
    } catch (error) {
      logger.error('Error extracting trade balances', { error: error.message });
      return { solBalance: 0, splBalance: 0, publicKey: null };
    }
  }
}

module.exports = ApiResponseValidator;
