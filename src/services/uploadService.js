const apiClient = require('./apiClient');
const logger = require('../utils/logger');
const { AppError } = require('../middleware/errorHandler');
const ApiResponseValidator = require('../utils/apiResponseValidator');

class UploadService {
  /**
   * Upload image to Pinata via external API
   * @param {string} base64Data - Base64 encoded image data
   * @param {string} fileName - Original file name
   * @param {string} contentType - MIME type (must start with 'image/')
   * @returns {Promise<Object>} Upload result with IPFS URLs
   */
  async uploadImage(base64Data, fileName, contentType) {
    try {
      logger.info('Uploading image to Pinata', {
        fileName,
        contentType,
        dataSize: base64Data.length
      });

      // Validate content type
      if (!contentType.startsWith('image/')) {
        throw new AppError(
          'Content type must be an image type (e.g., image/png, image/jpeg)',
          400,
          'INVALID_CONTENT_TYPE'
        );
      }

      // Clean base64 data if it includes data URI prefix
      let cleanBase64 = base64Data;
      if (base64Data.startsWith('data:')) {
        const base64Index = base64Data.indexOf(',');
        if (base64Index !== -1) {
          cleanBase64 = base64Data.substring(base64Index + 1);
        }
      }

      // Validate base64 format
      try {
        Buffer.from(cleanBase64, 'base64');
      } catch (error) {
        throw new AppError(
          'Invalid base64 image data',
          400,
          'INVALID_BASE64'
        );
      }

      const uploadData = {
        fileName,
        contentType,
        imageBase64: cleanBase64
      };

      const response = await apiClient.post('/api/v1/upload/pinata-image', uploadData);

      if (!ApiResponseValidator.validateUploadResponse(response)) {
        throw new AppError('Invalid upload response format', 502, 'UPLOAD_INVALID_RESPONSE');
      }

      logger.info('Image uploaded successfully', {
        fileName,
        cid: response.data.cid,
        gatewayUrl: response.data.gatewayUrl
      });

      return response.data;
    } catch (error) {
      logger.error('Error uploading image:', {
        fileName,
        contentType,
        error: error.message
      });
      
      if (error instanceof AppError) {
        throw error;
      }
      
      throw new AppError(
        'Failed to upload image via external API',
        502,
        'EXTERNAL_UPLOAD_API_ERROR'
      );
    }
  }

  /**
   * Process and upload logo from base64 data URI
   * @param {string} logoBase64 - Base64 data URI or raw base64
   * @param {string} [fileName] - Optional file name (generated if not provided)
   * @returns {Promise<string>} Gateway URL of uploaded image
   */
  async processAndUploadLogo(logoBase64, fileName = null) {
    try {
      if (!logoBase64) {
        throw new AppError('Logo data is required', 400, 'MISSING_LOGO_DATA');
      }

      // Extract content type and data from data URI if present
      let contentType = 'image/png'; // default
      let base64Data = logoBase64;
      let generatedFileName = fileName || `logo-${Date.now()}.png`;

      if (logoBase64.startsWith('data:')) {
        const matches = logoBase64.match(/^data:([^;]+);base64,(.+)$/);
        if (matches) {
          contentType = matches[1];
          base64Data = matches[2];
          
          // Generate filename based on content type if not provided
          if (!fileName) {
            const extension = contentType.split('/')[1] || 'png';
            generatedFileName = `logo-${Date.now()}.${extension}`;
          }
        }
      }

      const uploadResult = await this.uploadImage(base64Data, generatedFileName, contentType);
      return uploadResult.gatewayUrl;
    } catch (error) {
      logger.error('Error processing and uploading logo:', error);
      
      if (error instanceof AppError) {
        throw error;
      }
      
      throw new AppError(
        'Failed to process and upload logo',
        500,
        'LOGO_PROCESSING_FAILED'
      );
    }
  }

  /**
   * Validate image data and size
   * @param {string} base64Data - Base64 image data
   * @param {number} [maxSizeMB] - Maximum size in MB (default: 5MB)
   * @returns {boolean} True if valid
   */
  validateImageSize(base64Data, maxSizeMB = 5) {
    try {
      // Calculate size in bytes (base64 is ~4/3 the size of original)
      const sizeInBytes = (base64Data.length * 3) / 4;
      const sizeInMB = sizeInBytes / (1024 * 1024);

      if (sizeInMB > maxSizeMB) {
        throw new AppError(
          `Image size (${sizeInMB.toFixed(2)}MB) exceeds maximum allowed size (${maxSizeMB}MB)`,
          400,
          'IMAGE_TOO_LARGE'
        );
      }

      return true;
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      
      throw new AppError(
        'Failed to validate image size',
        400,
        'IMAGE_VALIDATION_FAILED'
      );
    }
  }
}

module.exports = new UploadService();
