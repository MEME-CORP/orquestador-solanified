# Bundler Orchestrator API

A Node.js Express API that orchestrates crypto wallet bundling operations, managing data flow between clients, external blockchain APIs, and a Supabase database.

## Features

- **In-App Wallet Creation**: Generate Solana wallets for users
- **Bundler Management**: Create and manage wallet bundlers with mother/child wallet hierarchy
- **Token Operations**: Create tokens on Pump.fun and execute buy/sell operations
- **Fund Management**: Transfer SOL between wallets with proper balance tracking
- **Database Integration**: PostgreSQL with Supabase for data persistence
- **Error Handling**: Comprehensive error handling with retry mechanisms
- **Validation**: Input validation with Joi
- **Logging**: Structured logging with Winston
- **Security**: Rate limiting, CORS, and security headers

## Architecture

### Database Structure
- **Users**: Store user wallet information and in-app wallet keys
- **Mother Wallets**: Primary wallets that manage child wallet groups
- **Child Wallets**: Individual wallets used for token operations
- **Bundlers**: Groups of mother wallets assigned to users
- **Tokens**: Token metadata and contract information

### API Endpoints

All endpoints are POST requests under `/api/orchestrator`:

1. **`/create-wallet-in-app`** - Create in-app wallet for user
2. **`/create-bundler`** - Create bundler with mother wallets
3. **`/create-and-buy-token-pumpFun`** - Create token and execute initial buy
4. **`/sell-created-token`** - Sell tokens with specified percentage
5. **`/sell-spl-from-wallet`** - Sell SPL tokens directly from user's in-app wallet
6. **`/verify-in-app-sol-balance`** - Verify and update in-app wallet SOL balance
7. **`/transfer-to-owner-wallet`** - Transfer SOL back to user's main wallet

## Installation

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd bundler-orchestrator
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Set up environment variables**
   ```bash
   cp env.example .env
   # Edit .env with your actual configuration
   ```

4. **Set up the database**
   - Create a Supabase project
   - Run the SQL schema from `database_structure.txt`
   - Update your `.env` file with Supabase credentials

5. **Create logs directory**
   ```bash
   mkdir logs
   ```

## Configuration

### Environment Variables

#### Supabase Configuration
```env
SUPABASE_URL=https://your-project-id.supabase.co
SUPABASE_ANON_KEY=your-anon-key-here
```

#### External API Configuration
```env
EXTERNAL_API_BASE_URL=http://localhost:8080/api/v1
EXTERNAL_API_KEY=your-api-key-here
```

#### Server Configuration
```env
PORT=3000
NODE_ENV=development
LOG_LEVEL=info
ALLOWED_ORIGINS=http://localhost:3000,http://localhost:3001
```

## Usage

### Development
```bash
npm run dev
```

### Production
```bash
npm start
```

### Health Check
```bash
curl http://localhost:3000/health
```

## API Documentation

### Create In-App Wallet
```http
POST /api/orchestrator/create-wallet-in-app
Content-Type: application/json

{
  "user_wallet_id": "user_wallet_address_here"
}
```

**Response:**
```json
{
  "in_app_public_key": "generated_public_key",
  "balance_sol": "0"
}
```

### Create Bundler
```http
POST /api/orchestrator/create-bundler
Content-Type: application/json

{
  "user_wallet_id": "user_wallet_address",
  "bundler_balance": X,
  "idempotency_key": "optional-uuid"
}
```

**Response:**
```json
{
  "bundler_id": 123,
  "allocated_mother_wallets": [
    {"id": 10, "public_key": "mother_wallet_1"},
    {"id": 11, "public_key": "mother_wallet_2"}
  ],
  "total_balance_sol": "3.000000000",
  "message": "Bundler created and funded."
}
```

### Create and Buy Token
```http
POST /api/orchestrator/create-and-buy-token-pumpFun
Content-Type: application/json

{
  "user_wallet_id": "user_wallet_address",
  "name": "My Token",
  "symbol": "MTK",
  "description": "A great token",
  "logo_base64": "data:image/png;base64,...",
  "twitter": "@mytoken",
  "telegram": "@mytoken",
  "website": "https://mytoken.com",
  "dev_buy_amount": "1.5",
  "slippage": 1.0,
  "priority_fee": "0.000005"
}
```

### Sell Token (from Bundler)
```http
POST /api/orchestrator/sell-created-token
Content-Type: application/json

{
  "user_wallet_id": "user_wallet_address",
  "sell_percent": 50
}
```

### Sell SPL Tokens (from In-App Wallet)
```http
POST /api/orchestrator/sell-spl-from-wallet
Content-Type: application/json

{
  "user_wallet_id": "user_wallet_address",
  "sell_percent": 50
}
```

**Response:**
```json
{
  "transaction_signature": "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW",
  "sell_percent": 50,
  "sold_amount_spl": 1250000.5,
  "remaining_spl_balance": 1250000.5,
  "new_sol_balance": 0.15432,
  "token_contract_address": "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R"
}
```

> **Note:** This endpoint automatically uses the most recent token created by the user. The token contract address is retrieved from the database based on the highest ID for the given user.

### Verify In-App SOL Balance
```http
POST /api/orchestrator/verify-in-app-sol-balance
Content-Type: application/json

{
  "user_wallet_id": "user_wallet_address"
}
```

**Response:**
```json
{
  "user_wallet_id": "user_wallet_address",
  "in_app_public_key": "in_app_wallet_public_key",
  "previous_balance_sol": "1.234567890",
  "current_balance_sol": "2.345678901",
  "balance_updated": true
}
```

### Transfer to Owner
```http
POST /api/orchestrator/transfer-to-owner-wallet
Content-Type: application/json

{
  "user_wallet_id": "user_wallet_address",
  "amount_sol": "0.5"
}
```

## Error Handling

The API uses standardized error responses:

```json
{
  "ok": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Human readable error message"
  }
}
```

Common error codes:
- `VALIDATION_ERROR`: Input validation failed
- `USER_NOT_FOUND`: User doesn't exist
- `TOKEN_NOT_FOUND`: No token found for user
- `INSUFFICIENT_BALANCE`: Not enough SOL for operation
- `EXTERNAL_API_ERROR`: External blockchain API error
- `BUNDLER_CREATION_FAILED`: Failed to create bundler
- `NO_IN_APP_WALLET`: User doesn't have an in-app wallet
- `NO_SPL_TOKENS_TO_SELL`: No SPL tokens available to sell
- `SELL_AMOUNT_TOO_SMALL`: Calculated sell amount is below minimum threshold

## Logging

Logs are written to:
- `logs/combined.log` - All logs
- `logs/error.log` - Error logs only
- Console (development mode)

Log levels: `error`, `warn`, `info`, `debug`

## Security Features

- **Rate Limiting**: 100 requests per 15 minutes per IP
- **CORS**: Configurable allowed origins
- **Input Validation**: Joi schema validation
- **Security Headers**: Helmet.js security headers
- **Error Sanitization**: No sensitive data in error responses

## Database Triggers

The database includes triggers that automatically maintain:
- Mother wallet availability status
- Child wallet balance aggregations
- Bundler total balances

## External Dependencies

- **Supabase**: Database and authentication
- **External Blockchain API**: Wallet operations and token transactions
- **Pinata**: IPFS image storage (via external API)

## Development

### Project Structure
```
src/
├── config/          # Database and configuration
├── controllers/     # Request handlers
├── middleware/      # Express middleware
├── models/         # Database access layer
├── routes/         # API route definitions
├── services/       # External API clients
├── utils/          # Utilities and helpers
└── validators/     # Input validation schemas
```

### Testing
```bash
npm test
```

### Linting
The project includes comprehensive input validation and error handling. Make sure to test all edge cases and error scenarios.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## License

MIT License - see LICENSE file for details.
