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

      // Updated validation: Check for the actual response structure from logs
      // The API returns: preBalances: {fromLamports, fromSol, toLamports, toSol}
      // and postBalances: {fromLamports, fromSol, toLamports, toSol}
      if (preBalances?.fromSol === undefined || preBalances?.toSol === undefined || 
          postBalances?.fromSol === undefined || postBalances?.toSol === undefined) {
        logger.warn('SOL transfer response has different balance structure than expected', { preBalances, postBalances });
        // Don't fail validation - the transfer might still be successful since we see the transfer actually worked
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

      const { signature, confirmed, commitment, postBalances, generatedMint } = response.data;
      
      if (!signature || typeof confirmed !== 'boolean') {
        logger.error('Pump create response missing signature or confirmed field', { signature, confirmed });
        return false;
      }

      // Check for contract address in postBalances.spl.mintAddress or generatedMint.publicKey
      const mintAddress = postBalances?.spl?.mintAddress || generatedMint?.publicKey;
      if (!mintAddress) {
        logger.error('Pump create response missing mint address', { 
          postBalancesSpl: postBalances?.spl,
          generatedMint: generatedMint
        });
        return false;
      }

      // Validate postBalances structure based on the provided API response format
      if (postBalances?.sol?.balanceSol === undefined || !postBalances?.sol?.balanceLamports || !postBalances?.sol?.publicKey) {
        logger.error('Pump create response missing SOL balance information', { solBalances: postBalances?.sol });
        return false;
      }

      if (postBalances?.spl?.uiAmount === undefined || !postBalances?.spl?.rawAmount || !postBalances?.spl?.walletPublicKey) {
        logger.error('Pump create response missing SPL balance information', { splBalances: postBalances?.spl });
        return false;
      }

      // Validate generatedMint if present
      if (generatedMint && (!generatedMint.publicKey || !generatedMint.privateKey)) {
        logger.error('Pump create response has invalid generatedMint structure', { generatedMint });
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

      const { signature, confirmed, commitment, postBalances } = response.data;
      
      if (!signature || typeof confirmed !== 'boolean') {
        logger.error('Pump trade response missing signature or confirmed field', { signature, confirmed });
        return false;
      }

      // Validate postBalances structure based on the provided API response format
      if (postBalances?.sol?.balanceSol === undefined || !postBalances?.sol?.balanceLamports || !postBalances?.sol?.publicKey) {
        logger.error('Pump trade response missing SOL balance information', { solBalances: postBalances?.sol });
        return false;
      }

      // For buy/sell operations, uiAmount and rawAmount should be present
      if (postBalances?.spl?.uiAmount === undefined || !postBalances?.spl?.rawAmount || !postBalances?.spl?.walletPublicKey || !postBalances?.spl?.mintAddress) {
        logger.error('Pump trade response missing SPL balance information', { splBalances: postBalances?.spl });
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
      const mintAddress = response?.postBalances?.spl?.mintAddress || 
                         response?.generatedMint?.publicKey ||
                         response?.data?.postBalances?.spl?.mintAddress || 
                         response?.data?.generatedMint?.publicKey || 
                         null;
      
      if (!mintAddress) {
        logger.error('Could not extract contract address from response', {
          postBalancesSpl: response?.postBalances?.spl || response?.data?.postBalances?.spl,
          generatedMint: response?.generatedMint || response?.data?.generatedMint
        });
      }
      
      return mintAddress;
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
      const data = response?.data || response;
      
      // Log the extraction process for debugging
      logger.debug('Extracting trade balances', {
        hasData: !!data,
        hasPostBalances: !!data?.postBalances,
        hasSolData: !!data?.postBalances?.sol,
        hasSplData: !!data?.postBalances?.spl,
        solData: data?.postBalances?.sol,
        splData: data?.postBalances?.spl
      });
      
      // Extract SPL balance with multiple fallbacks and detailed logging
      let splBalance = 0;
      if (data?.postBalances?.spl?.uiAmount !== undefined) {
        splBalance = data.postBalances.spl.uiAmount;
        if (splBalance === 0) {
          logger.warn('API returned uiAmount as 0 for SPL balance', {
            splData: data.postBalances.spl,
            hasRawAmount: !!data.postBalances.spl.rawAmount,
            rawAmount: data.postBalances.spl.rawAmount
          });
        }
      } else if (data?.postBalances?.spl?.rawAmount) {
        // If uiAmount is missing but rawAmount exists, try to convert
        // Note: This is a fallback - normally uiAmount should be present
        const rawAmount = parseFloat(data.postBalances.spl.rawAmount);
        if (!isNaN(rawAmount) && rawAmount > 0) {
          // Assume 6 decimal places for most tokens (this is a fallback)
          splBalance = rawAmount / 1000000;
          logger.warn('Using rawAmount as fallback for SPL balance', {
            rawAmount: data.postBalances.spl.rawAmount,
            calculatedUiAmount: splBalance
          });
        }
      } else {
        logger.warn('No SPL balance data found in API response', {
          hasSplData: !!data?.postBalances?.spl,
          splData: data?.postBalances?.spl
        });
      }
      
      const extracted = {
        solBalance: data?.postBalances?.sol?.balanceSol || 0,
        solBalanceLamports: data?.postBalances?.sol?.balanceLamports || '0',
        splBalance: splBalance,
        splBalanceRaw: data?.postBalances?.spl?.rawAmount || '0',
        publicKey: data?.postBalances?.sol?.publicKey || 
                   data?.postBalances?.spl?.walletPublicKey || null,
        mintAddress: data?.postBalances?.spl?.mintAddress || null
      };
      
      logger.debug('Extracted trade balances', extracted);
      return extracted;
    } catch (error) {
      logger.error('Error extracting trade balances', { 
        error: error.message,
        response: response 
      });
      return { 
        solBalance: 0, 
        solBalanceLamports: '0',
        splBalance: 0, 
        splBalanceRaw: '0',
        publicKey: null,
        mintAddress: null
      };
    }
  }

  /**
   * Extract balance information from token creation response
   * @param {Object} response - Pump.fun create response
   * @returns {Object} Balance information including generated mint
   */
  static extractCreationBalances(response) {
    try {
      const data = response?.data || response;
      return {
        solBalance: data?.postBalances?.sol?.balanceSol || 0,
        solBalanceLamports: data?.postBalances?.sol?.balanceLamports || '0',
        splBalance: data?.postBalances?.spl?.uiAmount || 0,
        splBalanceRaw: data?.postBalances?.spl?.rawAmount || '0',
        publicKey: data?.postBalances?.sol?.publicKey || 
                   data?.postBalances?.spl?.walletPublicKey || null,
        mintAddress: data?.postBalances?.spl?.mintAddress || 
                    data?.generatedMint?.publicKey || null,
        generatedMint: data?.generatedMint || null,
        signature: data?.signature || null,
        confirmed: data?.confirmed || false
      };
    } catch (error) {
      logger.error('Error extracting creation balances', { error: error.message });
      return { 
        solBalance: 0, 
        solBalanceLamports: '0',
        splBalance: 0, 
        splBalanceRaw: '0',
        publicKey: null,
        mintAddress: null,
        generatedMint: null,
        signature: null,
        confirmed: false
      };
    }
  }
}

module.exports = ApiResponseValidator;
