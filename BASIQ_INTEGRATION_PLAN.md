# Ray Finance: Basiq Integration Plan

This is a personal fork of [ray-finance](https://github.com/cdinnison/ray-finance) being adapted to work with Australian banks via Basiq instead of Plaid.

## Goal

Replace the Plaid provider with Basiq so Ray can sync data from Australian banks under CDR (Consumer Data Right). The database schema, AI advisor, scoring, CLI, and Next.js site all stay the same — only the provider layer changes.

## Architecture

Ray's Plaid integration lives in three files in `src/plaid/`. The rest of the codebase reads from local SQLite and doesn't care about the data source. Our strategy:

1. Build a parallel `src/basiq/` folder with equivalent structure
2. Map Basiq's data shape into Ray's existing tables at the sync boundary
3. Keep the SQLite schema unchanged
4. Preserve Plaid's Personal Finance Category (PFC) strings as Ray's internal category vocabulary — scoring code hard-codes them

## Files we're building

```
src/basiq/
  types.ts        # TypeScript types for Basiq API responses
  client.ts       # Authenticated HTTP client with token caching
  auth.ts         # Server and client token management
  consent.ts      # Consent UI URL construction and callback handling
  link.ts         # User creation, connection initiation
  sync.ts         # The big one — account and transaction sync logic
  categories.ts   # Basiq category → Plaid PFC mapping table
```

## Files we're modifying

- `src/config.ts` — swap Plaid config fields for Basiq equivalents
- `src/daily-sync.ts` — call Basiq sync instead of Plaid sync
- `src/server.ts` — replace Plaid Link endpoints with Basiq consent handlers
- `src/cli/setup.ts` — update onboarding for Basiq
- `src/cli/doctor.ts` — update health checks

## Basiq fundamentals

### Two-token authentication

- **Server token**: SERVER_ACCESS scope. Obtained by exchanging our API key. Valid 60 minutes. Used for all backend calls (creating users, fetching data, refreshing connections).
- **Client token**: CLIENT_ACCESS scope, bound to a userId. Used only when redirecting to the Basiq Consent UI for bank connection.

### Sign convention (critical)

Plaid: positive amount = money out, negative = money in.
Basiq: positive = credit (money in), negative = debit (money out).

**Must flip the sign when mapping transactions.** Get this wrong and every scoring/budget calculation inverts silently.

### Async job model

Unlike Plaid's immediate responses, Basiq operations are asynchronous. Creating a connection or refreshing data creates a `job` with three steps:
1. `verify-credentials`
2. `retrieve-accounts`
3. `retrieve-transactions`

We poll `GET /jobs/{jobId}` until all three succeed before reading data.

### Base URL

Australian endpoint: `https://au-api.basiq.io`

### API version

All requests must include header: `basiq-version: 3.0`

## Config changes

Replace in `RayConfig`:

Remove: `plaidClientId`, `plaidSecret`, `plaidEnv`, `plaidTokenSecret`, `plaidCountries`

Add:
- `basiqApiKey` — developer API key from dash.basiq.io
- `basiqUserId` — the Basiq userId representing the Ray user (created once during setup)
- `basiqEnv` — `"sandbox"` | `"production"`

Keep: `dbEncryptionKey`, `anthropicKey`, `model`, everything else.

## Data mapping

### Accounts

| Ray column | Basiq field |
|---|---|
| `account_id` | `account.id` |
| `item_id` | `account.connection` |
| `name` | `account.name` |
| `official_name` | `account.class.product` |
| `type` | derived from `account.class.type` |
| `subtype` | `account.class.type` |
| `mask` | last 4 of `account.accountNo` |
| `current_balance` | `account.balance` |
| `available_balance` | `account.availableFunds` |
| `currency` | `account.currency` |

Type mapping:
- `transaction`, `savings` → `depository`
- `credit-card` → `credit`
- `mortgage`, `loan` → `loan`
- `investment`, `term-deposit` → `investment`

### Transactions

| Ray column | Basiq field |
|---|---|
| `transaction_id` | `transaction.id` |
| `account_id` | `transaction.account` |
| `amount` | `-transaction.amount` (sign flip) |
| `date` | `transaction.postDate` (fallback `transactionDate`) |
| `name` | `transaction.description` |
| `merchant_name` | `transaction.enrich.merchant.businessName` |
| `category` | mapped PFC string via categories.ts |
| `subcategory` | Basiq subcategory, uppercased |
| `pending` | `transaction.status === 'pending' ? 1 : 0` |
| `iso_currency_code` | `transaction.currency` |

## Implementation order

1. Types (`types.ts`) — TypeScript types for what Basiq returns
2. Auth (`auth.ts`) — server token with caching and refresh
3. Client (`client.ts`) — HTTP wrapper using authenticated tokens
4. User creation — one-time setup, creates the Basiq user
5. Consent flow (`consent.ts`, `link.ts`) — browser handoff for bank connection
6. Account sync — pull accounts, map, upsert
7. Transaction sync (`sync.ts`) — the big one, plus category mapping
8. Wire into `daily-sync.ts`
9. Sandbox end-to-end test
10. Production activation (later, only after sandbox is working)

## Known gaps and accepted trade-offs

- **Recurring streams**: Plaid auto-detects recurring payments; Basiq doesn't. May build a simple detector or drop the feature.
- **Liabilities**: Basiq returns account balances for mortgages/loans but not the rich fields (APR, next payment due) Plaid exposes. Most liability columns will stay null.
- **Investments**: Account-level balances work; holding-level detail (specific shares, cost basis) is inconsistent. Fill in manually where needed.
- **Consent expiry**: CDR consents expire (default 90 days, configurable up to 365). Need a reconnect flow when `connection.status === 'invalid'`.

## Non-goals for now

- Webhooks (polling via daily sync is sufficient for personal use)
- Production activation (sandbox first)
- Multi-user support (single-user personal tool)
- Payments / action initiation
- Business CDR consent
