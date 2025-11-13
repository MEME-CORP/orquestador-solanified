# Orquestador-Solanified Canon

This document is the canonical source of truth for the post-refactor architecture and operational practices. All contributors—human or AI—must consult and align with this canon before making changes.

---

## 1. Environment & Infrastructure

1. **Render Free Tier Constraints**
   - Free-tier services hibernate after ~15 minutes of inactivity. POST requests no longer wake sleeping services reliably (as of July 2025).
   - Render’s router returns `429` with header `x-render-routing: rate-limited` when the service is still asleep. Treat these as edge throttling events and avoid rapid retries.
   - Preferred wake trigger: a long-timeout `GET /healthz` (or `/`) request with single-flight coordination.

2. **Orchestrator Warm-Up Strategy**
   - `src/services/rawApiClient.js` encapsulates the warm-up and request logic. It performs health-gated GETs before POST calls and respects router hints, preventing retry storms.
   - Shoulder key health configuration: `EXTERNAL_API_HEALTH_TIMEOUT_MS`, `EXTERNAL_API_HEALTH_TTL_MS`, `EXTERNAL_API_HEALTH_COOLDOWN_MS`.
   - Keep `EXTERNAL_API_WARMUP_MODE=passive` by default; the rawApiClient handles warm-ups reactively.

3. **Express Server Configuration**
   - `app.set('trust proxy', 1)` is mandatory for Render to avoid `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR`.
   - Rate limiting must use env-driven configuration (`RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_MS`). No hardcoded limits.

---

## 2. Data Model & Wallet Semantics

1. **Distributor vs Dev Wallet**
   - The `distributor_*` fields in the `users` table hold the canonical in-app wallet keys and balances. Legacy fields (`in_app_public_key`, `in_app_private_key`, `balance_sol`) exist only for backwards compatibility and must be treated as fallbacks.
   - Dev wallet is optional and created asynchronously after distributor wallet provisioning. Its fields: `dev_private_key`, `dev_public_key`, `dev_balance_sol`, `dev_balance_spl`.

2. **User Retrieval Helpers**
   - Use `getDistributorWallet(user)` to obtain `{ publicKey, privateKey }` with legacy fallbacks.
   - Use `getDistributorBalanceSol(user)` to read existing SOL balance. Never read `user.balance_sol` directly.

3. **Balance Updates**
   - Always persist changes through `userModel.updateSolBalance` / `updateSplBalance` / `updateBalances` as appropriate.
   - Controllers must log previous vs current balances using distributor fields.

---

## 3. Controller Responsibilities

1. **createWalletInApp**
   - Calls `walletService.createInAppWallet` (which uses `rawApiClient`).
   - Persists distributor wallet keys via `userModel.createUser`.
   - Sends creation notifications through `notificationService`.

2. **verifyInAppSolBalance**
   - Must call `getDistributorWallet` and fail if no distributor public key.
   - Fetches blockchain balance with `walletService.getSolBalance` and updates via `userModel.updateSolBalance`.
   - Response payload uses `distributor_public_key` and includes previous/current SOL balances.

3. **verifyUserSplBalance**
   - Same distributor wallet helper usage.
   - Pulls latest token via `tokenModel.getLatestTokenByUser` and reconciles SPL balance with blockchain data.

4. **sellSplFromWallet**
   - Distributor wallet keys are required for both balance checks and Pump.fun interactions.
   - On 0-balance responses, follow the recovery strategy: retry blockchain check, then estimate remainder if necessary.

5. **transferToOwnerWallet**
   - Uses distributor wallet credentials to send SOL to the user’s external wallet.
   - Updates balances through `userModel.updateSolBalance` and returns the new SOL balance.

---

## 4. Services

1. **rawApiClient**
   - Single source of truth for raw API interactions.
   - Health gating via single-flight GET `/` (configurable via `EXTERNAL_API_HEALTHZ_PATH`).
   - Throws `BLOCKCHAIN_API_RATE_LIMITED` when Render router blocks requests.

2. **walletService**
   - Delegates wallet creation to `rawApiClient` and aggregates responses.
   - `getSolBalance` uses the shared `apiClient` but assumes the caller has already ensured the raw API is awake.

3. **notificationService**
   - Sends structured payloads to the frontend. Always include `in_app_public_key` for compatibility.

---

## 5. Logging & Diagnostics

1. **Winston Logger**
   - All controllers must log with the provided `logger`. No `console.log`.
   - Include context: `requestId`, `user_wallet_id`, wallet public keys (redacted private keys), and timing metrics.

2. **Warm-Up Diagnostics**
   - Enable via `EXTERNAL_API_WARMUP_DIAGNOSTICS=true`. Logs appear with `🔥 [API_CLIENT]` prefix.
   - Capture router headers (`x-render-routing`), `Retry-After`, and body samples (trimmed to 200 chars).

---

## 6. Error Handling

1. **Standard Error Responses**
   - Controllers throw `AppError` with codes like `USER_NOT_FOUND`, `NO_IN_APP_WALLET`, `BLOCKCHAIN_API_RATE_LIMITED`.
   - `errorHandler` middleware converts all errors into `{ ok: false, error: { code, message } }`.

2. **Render Router Failures**
   - Treat recurring 429s with `rate-limited` header as upstream throttling. Do not loop requests without a warm-up.
   - After warm-up failure, surface a 503 with guidance to retry later.

---

## 7. Change Management Guidelines

1. **Before Implementing**
   - Review this canon.
   - Update the canon first if new contracts or workflows are introduced.

2. **Testing Expectations**
   - Ensure orchestrator boots (`npm run dev`) with no warnings.
   - Exercise cold-start scenarios with diagnostics enabled to validate warm-up behavior.

3. **Documentation & Governance**
   - Any deviation from the canon requires explicit documentation within this file before implementation.
   - .windsurf rules reference this canon; failing to adhere is considered a violation of project policy.

---

_Last updated: 2025-11-13_
