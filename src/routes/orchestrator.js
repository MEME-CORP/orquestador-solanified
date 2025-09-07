const express = require('express');
const router = express.Router();

const orchestratorController = require('../controllers/orchestratorController');
const { validateRequest } = require('../validators/orchestratorValidators');
const {
  createWalletInAppSchema,
  createBundlerSchema,
  createAndBuyTokenSchema,
  sellCreatedTokenSchema,
  sellSplFromWalletSchema,
  transferToOwnerWalletSchema,
  verifyInAppSolBalanceSchema,
  verifySplBalancesSchema
} = require('../validators/orchestratorValidators');

/**
 * Create in-app wallet for user
 * POST /api/orchestrator/create-wallet-in-app
 */
router.post(
  '/create-wallet-in-app',
  validateRequest(createWalletInAppSchema),
  orchestratorController.createWalletInApp
);

/**
 * Create bundler with mother wallets
 * POST /api/orchestrator/create-bundler
 */
router.post(
  '/create-bundler',
  validateRequest(createBundlerSchema),
  orchestratorController.createBundler
);

/**
 * Create token and buy with bundler
 * POST /api/orchestrator/create-and-buy-token-pumpFun
 */
router.post(
  '/create-and-buy-token-pumpFun',
  validateRequest(createAndBuyTokenSchema),
  orchestratorController.createAndBuyTokenPumpFun
);

/**
 * Sell created token
 * POST /api/orchestrator/sell-created-token
 */
router.post(
  '/sell-created-token',
  validateRequest(sellCreatedTokenSchema),
  orchestratorController.sellCreatedToken
);

/**
 * Sell SPL tokens from user's in-app wallet
 * POST /api/orchestrator/sell-spl-from-wallet
 */
router.post(
  '/sell-spl-from-wallet',
  validateRequest(sellSplFromWalletSchema),
  orchestratorController.sellSplFromWallet
);

/**
 * Verify in-app SOL balance
 * POST /api/orchestrator/verify-in-app-sol-balance
 */
router.post(
  '/verify-in-app-sol-balance',
  validateRequest(verifyInAppSolBalanceSchema),
  orchestratorController.verifyInAppSolBalance
);

/**
 * Transfer SOL to owner wallet
 * POST /api/orchestrator/transfer-to-owner-wallet
 */
router.post(
  '/transfer-to-owner-wallet',
  validateRequest(transferToOwnerWalletSchema),
  orchestratorController.transferToOwnerWallet
);

/**
 * Verify and update SPL balances for wallets after transaction settlement
 * POST /api/orchestrator/verify-spl-balances
 */
router.post(
  '/verify-spl-balances',
  validateRequest(verifySplBalancesSchema),
  orchestratorController.verifySplBalances
);

module.exports = router;
