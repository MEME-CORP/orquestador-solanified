const axios = require('axios');
const logger = require('../utils/logger');

class NotificationService {
  constructor() {
    this.frontendUrl = process.env.FRONTEND_URL || 'https://frontend-solanified.onrender.com';
    this.notificationClient = axios.create({
      timeout: 100000, // 10 seconds for notifications
      headers: {
        'Content-Type': 'application/json'
      }
    });
  }

  /**
   * Send wallet creation success notification to frontend
   * @param {string} userWalletId - User's wallet ID
   * @param {string} inAppPublicKey - Created in-app wallet public key
   * @returns {Promise<void>}
   */
  async sendWalletCreationNotification(userWalletId, inAppPublicKey) {
    const notificationStart = Date.now();
    
    try {
      logger.info('📢 [NOTIFICATION_SERVICE] Preparing wallet creation notification', {
        userWalletId,
        inAppPublicKey,
        frontendUrl: this.frontendUrl,
        notification_type: 'WALLET_CREATED'
      });

      const notificationData = {
        type: 'WALLET_CREATED',
        message: 'Wallet was created successfully',
        user_wallet_id: userWalletId,
        in_app_public_key: inAppPublicKey,
        timestamp: new Date().toISOString()
      };

      logger.info('📡 [NOTIFICATION_SERVICE] Sending notification to frontend', {
        userWalletId,
        frontendUrl: this.frontendUrl,
        endpoint: '/api/notifications',
        payload_size: JSON.stringify(notificationData).length
      });

      // Send notification to frontend
      const response = await this.notificationClient.post(`${this.frontendUrl}/api/notifications`, notificationData);
      const notificationTime = Date.now() - notificationStart;

      logger.info('✅ [NOTIFICATION_SERVICE] Notification sent successfully', {
        userWalletId,
        inAppPublicKey,
        frontendUrl: this.frontendUrl,
        notification_time_ms: notificationTime,
        response_status: response.status,
        response_data: response.data
      });

    } catch (error) {
      const notificationTime = Date.now() - notificationStart;
      
      // Log error details for debugging
      logger.error('❌ [NOTIFICATION_SERVICE] Failed to send wallet creation notification', {
        userWalletId,
        inAppPublicKey,
        frontendUrl: this.frontendUrl,
        notification_time_ms: notificationTime,
        error_message: error.message,
        error_code: error.code,
        is_network_error: !error.response,
        http_status: error.response?.status,
        response_data: error.response?.data,
        error_stack: error.stack
      });

      // Log specific error types for better debugging
      if (!error.response) {
        logger.warn('🌐 [NOTIFICATION_SERVICE] Network error - frontend may be unreachable', {
          userWalletId,
          frontendUrl: this.frontendUrl,
          error_details: 'Could not connect to frontend notification endpoint'
        });
      } else if (error.response.status === 404) {
        logger.warn('🔍 [NOTIFICATION_SERVICE] Frontend notification endpoint not found', {
          userWalletId,
          frontendUrl: this.frontendUrl,
          endpoint: '/api/notifications',
          suggestion: 'Check if frontend has implemented the notification endpoint'
        });
      } else if (error.response.status >= 500) {
        logger.error('🚨 [NOTIFICATION_SERVICE] Frontend server error', {
          userWalletId,
          frontendUrl: this.frontendUrl,
          http_status: error.response.status,
          error_details: 'Frontend notification endpoint returned server error'
        });
      }
      
      // Re-throw error so controller can handle it appropriately
      throw error;
    }
  }

  /**
   * Send generic notification to frontend
   * @param {string} type - Notification type
   * @param {string} message - Notification message
   * @param {Object} data - Additional data
   * @returns {Promise<void>}
   */
  async sendNotification(type, message, data = {}) {
    try {
      logger.info('Sending notification to frontend', {
        type,
        message,
        frontendUrl: this.frontendUrl
      });

      const notificationData = {
        type,
        message,
        ...data,
        timestamp: new Date().toISOString()
      };

      await this.notificationClient.post(`${this.frontendUrl}/api/notifications`, notificationData);

      logger.info('Notification sent successfully', { type });
    } catch (error) {
      logger.error('Failed to send notification:', {
        type,
        error: error.message,
        frontendUrl: this.frontendUrl
      });
    }
  }
}

module.exports = new NotificationService();
