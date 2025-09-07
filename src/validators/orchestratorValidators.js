const Joi = require('joi');

// Base wallet ID validation
const walletIdSchema = Joi.string()
  .pattern(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)
  .required()
  .messages({
    'string.pattern.base': 'Invalid wallet address format',
    'any.required': 'Wallet ID is required'
  });

// SOL amount validation (must be positive number with up to 9 decimal places)
const solAmountSchema = Joi.number()
  .positive()
  .precision(9)
  .messages({
    'number.positive': 'Amount must be positive',
    'number.precision': 'Amount cannot have more than 9 decimal places'
  });

// Create in-app wallet validation
const createWalletInAppSchema = Joi.object({
  user_wallet_id: walletIdSchema
});

// Create bundler validation
const createBundlerSchema = Joi.object({
  user_wallet_id: walletIdSchema,
  bundler_balance: Joi.number()
    .integer()
    .min(1)
    .max(100)
    .required()
    .messages({
      'number.integer': 'Bundler balance must be an integer',
      'number.min': 'Bundler balance must be at least 1',
      'number.max': 'Bundler balance cannot exceed 100',
      'any.required': 'Bundler balance is required'
    }),
  idempotency_key: Joi.string()
    .uuid()
    .optional()
});

// Token creation validation
const createAndBuyTokenSchema = Joi.object({
  user_wallet_id: walletIdSchema,
  name: Joi.string()
    .min(1)
    .max(32)
    .required()
    .messages({
      'string.min': 'Token name must be at least 1 character',
      'string.max': 'Token name cannot exceed 32 characters',
      'any.required': 'Token name is required'
    }),
  symbol: Joi.string()
    .pattern(/^[A-Z0-9]{1,10}$/)
    .required()
    .messages({
      'string.pattern.base': 'Token symbol must be 1-10 uppercase letters and numbers only',
      'any.required': 'Token symbol is required'
    }),
  description: Joi.string()
    .max(500)
    .required()
    .messages({
      'string.max': 'Description cannot exceed 500 characters',
      'any.required': 'Description is required'
    }),
  logo_base64: Joi.string()
    .pattern(/^data:image\/(png|jpeg|jpg|gif);base64,/)
    .required()
    .messages({
      'string.pattern.base': 'Logo must be a valid base64 data URI for an image',
      'any.required': 'Logo is required'
    }),
  twitter: Joi.string()
    .pattern(/^@?[A-Za-z0-9_]{1,15}$/)
    .optional()
    .allow('')
    .messages({
      'string.pattern.base': 'Invalid Twitter handle format'
    }),
  telegram: Joi.string()
    .pattern(/^@?[A-Za-z0-9_]{5,32}$/)
    .optional()
    .allow('')
    .messages({
      'string.pattern.base': 'Invalid Telegram handle format'
    }),
  website: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .optional()
    .allow('')
    .messages({
      'string.uri': 'Website must be a valid URL'
    }),
  dev_buy_amount: solAmountSchema
    .min(0.001)
    .max(10)
    .required()
    .messages({
      'number.min': 'Dev buy amount must be at least 0.001 SOL',
      'number.max': 'Dev buy amount cannot exceed 10 SOL',
      'any.required': 'Dev buy amount is required'
    }),
  slippage: Joi.number()
    .min(0.1)
    .max(50)
    .required()
    .messages({
      'number.min': 'Slippage must be at least 0.1%',
      'number.max': 'Slippage cannot exceed 50%',
      'any.required': 'Slippage is required'
    }),
  priority_fee: solAmountSchema
    .min(0.000001)
    .max(0.01)
    .optional()
    .messages({
      'number.min': 'Priority fee must be at least 0.000001 SOL',
      'number.max': 'Priority fee cannot exceed 0.01 SOL'
    })
});

// Token sell validation
const sellCreatedTokenSchema = Joi.object({
  user_wallet_id: walletIdSchema,
  sell_percent: Joi.number()
    .integer()
    .min(1)
    .max(100)
    .required()
    .messages({
      'number.integer': 'Sell percentage must be an integer',
      'number.min': 'Sell percentage must be at least 1%',
      'number.max': 'Sell percentage cannot exceed 100%',
      'any.required': 'Sell percentage is required'
    })
});

// Transfer to owner wallet validation
const transferToOwnerWalletSchema = Joi.object({
  user_wallet_id: walletIdSchema,
  amount_sol: solAmountSchema
    .min(0.0001)
    .required()
    .messages({
      'number.min': 'Transfer amount must be at least 0.0001 SOL',
      'any.required': 'Transfer amount is required'
    })
});

// Sell SPL tokens from wallet validation
const sellSplFromWalletSchema = Joi.object({
  user_wallet_id: walletIdSchema,
  sell_percent: Joi.number()
    .integer()
    .min(1)
    .max(100)
    .required()
    .messages({
      'number.integer': 'Sell percentage must be an integer',
      'number.min': 'Sell percentage must be at least 1%',
      'number.max': 'Sell percentage cannot exceed 100%',
      'any.required': 'Sell percentage is required'
    })
});

// Verify in-app SOL balance validation
const verifyInAppSolBalanceSchema = Joi.object({
  user_wallet_id: walletIdSchema
});

const verifySplBalancesSchema = Joi.object({
  mintAddress: Joi.string().required(),
  walletPublicKeys: Joi.array().items(Joi.string()).min(1).required()
});

// Validation middleware factory
const validateRequest = (schema) => {
  return (req, res, next) => {
    const { error, value } = schema.validate(req.body, {
      abortEarly: false,
      stripUnknown: true
    });

    if (error) {
      const errorMessage = error.details.map(detail => detail.message).join(', ');
      return res.status(400).json({
        ok: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: errorMessage,
          details: error.details
        }
      });
    }

    // Replace req.body with validated and cleaned data
    req.body = value;
    next();
  };
};

module.exports = {
  createWalletInAppSchema,
  createBundlerSchema,
  createAndBuyTokenSchema,
  sellCreatedTokenSchema,
  sellSplFromWalletSchema,
  transferToOwnerWalletSchema,
  verifyInAppSolBalanceSchema,
  verifySplBalancesSchema,
  validateRequest
};
