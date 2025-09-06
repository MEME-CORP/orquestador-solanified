const axios = require('axios');
const logger = require('../utils/logger');

class NotificationService {
  constructor() {
    this.frontendUrl = process.env.FRONTEND_URL || 'https://frontend-solanified.vercel.app';
    this.notificationClient = axios.create({
      timeout: 10000, // 10 seconds for notifications
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
    try {
      logger.info('Sending wallet creation notification to frontend', {
        userWalletId,
        inAppPublicKey,
        frontendUrl: this.frontendUrl
      });

      const notificationData = {
        type: 'WALLET_CREATED',
        message: 'Wallet was created successfully',
        user_wallet_id: userWalletId,
        in_app_public_key: inAppPublicKey,
        timestamp: new Date().toISOString()
      };

      // Send notification to frontend
      await this.notificationClient.post(`${this.frontendUrl}/api/notifications`, notificationData);

      logger.info('Wallet creation notification sent successfully', { userWalletId });
    } catch (error) {
      // Log error but don't throw - notifications are not critical for the main flow
      logger.error('Failed to send wallet creation notification:', {
        userWalletId,
        error: error.message,
        frontendUrl: this.frontendUrl
      });
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
