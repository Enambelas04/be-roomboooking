# Spotto — Room/space Booking Platform Backend

A room booking and rental platform API where **customers book and pay without
creating an account**. Hosts and administrators authenticate; guests do not.

Built with Express, TypeScript, Prisma and SQLite (PostgreSQL-ready).

---

## Project overview

Three conceptual actors, each with a different authentication model:

| Actor | Authentication | Capabilities |
| --- | --- | --- |
| **Guest / Customer** | None — no login, no account, no JWT | Browse rooms, create a booking, pay, track the booking with a secure token |
| **Host** | JWT + `HOST` role | Manage own rooms, view bookings and revenue for own rooms |
| **Admin** | JWT + `ADMIN` role | Manage hosts, rooms, bookings, payments, refunds, ledger, platform revenue |

Guests are identified by a **secure tracking token** generated at booking time.
There is deliberately no `USER`, `CUSTOMER` or `GUEST` authentication role.

The payment layer is **provider-agnostic**: the core booking system never talks
to Midtrans or Xendit directly. A `PaymentGateway` interface isolates provider
specifics, and a `MockPaymentGateway` simulates a real provider in development.

---

## Architecture

```text
Client
  ↓
Express routes        src/api/routes/*
  ↓
Middleware            validate · rateLimit · rawBody · errorHandler
  ↓
Controllers           src/api/controllers/*
  ↓
Services              src/services/*
  ↓
Domain                src/domain/*  (statuses, money, errors)
  ↓
Database              Prisma → SQLite (dev) / PostgreSQL (prod)
```

Payments add one layer:

```text
Routes
  ↓
PaymentService              src/services/PaymentService.ts
  ↓
PaymentGateway (interface)  src/payment/PaymentGateway.ts
  ├── MockPaymentGateway    ✅ implemented
  ├── MidtransGateway       ← future
  └── XenditGateway         ← future
```

**`PaymentService` is the only component permitted to change payment or
booking payment-related state.** Controllers never write those fields directly.

### Directory map

```text
src/
├── api/
│   ├── routes/         public · auth · host · admin (access classes)
│   ├── controllers/    request handling, no business logic
│   ├── middleware/     validate · rateLimit · rawBody · errorHandler
│   ├── app.ts          middleware stack and mounting order
│   ├── schemas.ts      zod request schemas
│   └── serializers.ts  the only place DB rows become JSON
├── auth/               password hashing · JWT · requireAuth/requireRole
├── domain/             statuses + state machines · money · errors · email
├── payment/            PaymentGateway · MockPaymentGateway · registry
├── services/           PaymentService · BookingService · RoomService · AuthService
├── lib/                logger (with redaction) · roomLock
├── config/             env loading + startup validation
├── database/           Prisma client singleton
└── server.ts           entry point
```

---

## Local setup

Requirements: Node.js 20+ and npm.

```bash
git clone https://github.com/Enambelas04/be-roomboooking.git
cd be-roomboooking
npm install
```

`npm install` runs Prisma's postinstall. If your npm blocks install scripts,
approve them and generate the client explicitly:

```bash
npm approve-scripts --allow-scripts-pending
npx prisma generate
```

---

## Environment variables

Copy the example file and fill it in:

```bash
cp .env.example .env
```

`.env` is gitignored and must never be committed. See `.env.example` for the
full annotated list.

| Variable | Required | Purpose |
| --- | --- | --- |
| `NODE_ENV` | yes | `development` · `test` · `production` |
| `PORT` | yes | HTTP port (default 3000) |
| `APP_PUBLIC_URL` | yes | Public base URL; used to build webhook callbacks |
| `DATABASE_URL` | yes | Prisma connection string |
| `JWT_SECRET` | yes | **Minimum 32 characters.** Signing key |
| `JWT_EXPIRES_IN` | no | Token lifetime (default `1h`) |
| `PAYMENT_PROVIDER` | yes | `mock` · `midtrans` · `xendit` |
| `PAYMENT_WEBHOOK_SECRET` | yes | Webhook signature secret. Required even for `mock` |
| `PAYMENT_API_KEY` / `PAYMENT_SECRET_KEY` | no | Real provider credentials (unused by `mock`) |
| `PLATFORM_FEE_BPS` | yes | Platform commission in basis points. Must be **800–1200** |
| `GATEWAY_FEE_BPS` | no | Gateway fee in basis points (default 0) |
| `CORS_ORIGINS` | no | Comma-separated allowlist |
| `BODY_LIMIT` | no | Max request body size (default `100kb`) |
| `RATE_LIMIT_AUTH_MAX` | no | Auth attempts per window |
| `RATE_LIMIT_BOOKING_MAX` | no | Booking creations per window |
| `RATE_LIMIT_PAYMENT_MAX` | no | Payment creations per window |
| `RATE_LIMIT_WINDOW_MS` | no | Rate limit window |
| `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` | no | Seed account |
| `SEED_HOST_EMAIL` / `SEED_HOST_PASSWORD` | no | Seed account |

**Startup validation.** The server validates configuration on boot and
**refuses to start** on a bad value (short `JWT_SECRET`, `PLATFORM_FEE_BPS`
outside 800–1200, missing webhook secret, production still pointing at
localhost). It prints the offending variable *names* and never their values.

Generate a secret with:

```bash
openssl rand -hex 32
```

---

## Database setup

Development uses SQLite.

```bash
npx prisma migrate deploy     # apply migrations
npx prisma generate           # generate the client
npx prisma db seed            # optional demo admin + host + rooms
```

`prisma/seed.ts` reads the `SEED_*` variables from `.env`. Passwords are hashed
with bcrypt; nothing is hardcoded.

Inspect the database with Prisma Studio:

```bash
npx prisma studio
```

To reset development data: delete `prisma/dev.db` and re-run
`npx prisma migrate deploy`.

---

## Running the application

```bash
npm run dev      # tsx watch, reloads on change
npm run build    # tsc → dist/
npm start        # run the compiled build
npm run typecheck # tsc --noEmit
```

Health probe: `GET /health` → `{ "status": "ok", ... }`

---

## Running tests

```bash
npm test           # vitest run (single pass)
npm run test:watch # watch mode
```

The suite runs against a **dedicated SQLite database** (`prisma/test.db`,
gitignored) and truncates it between tests, so your development data is never
touched. `tests/setup.ts` sets the test environment before any application
module is imported, because `src/config` validates at import time.

Suites:

| File | Covers |
| --- | --- |
| `tests/guest-booking.test.ts` | Booking creation, server-side pricing, tracking tokens |
| `tests/payment-creation.test.ts` | Guest payment authorization, idempotency, client-input rejection |
| `tests/payment-webhook.test.ts` | Signature verification, replay dedup, amount tampering, providers |
| `tests/payment-lifecycle.test.ts` | FAILED / EXPIRED / retry / terminal-state handling |
| `tests/refund.test.ts` | Refund correctness and double-refund protection |
| `tests/booking-concurrency.test.ts` | Overbooking protection |
| `tests/auth-rbac.test.ts` | JWT auth, HOST/ADMIN RBAC, ownership, actor identity |
| `tests/public-api.test.ts` | Public routes, error shape, headers, CORS, body limit |
| `tests/rate-limit.test.ts` | Rate limiter behaviour |

---

## Guest booking flow

```text
Landing page
  ↓
Browse rooms                  GET  /api/rooms          PUBLIC
  ↓
Select room + dates
  ↓
Enter guest details
  ↓
Create booking                POST /api/bookings       GUEST
  ↓  returns { booking.id, booking.trackingToken }
Create payment                POST /api/payments/create GUEST + trackingToken
  ↓  returns { checkoutUrl }
Mock checkout / real gateway
  ↓
Webhook                       POST /api/payments/webhook  WEBHOOK
  ↓  signature verified
Payment PAID  →  Booking CONFIRMED  →  ledger + notification
```

Track a booking at any time:

```text
GET /api/bookings/:trackingToken     GUEST
```

### Booking security

The tracking token is 32 bytes of CSPRNG entropy, base64url-encoded — not
sequential and not guessable. An unknown or wrong token returns **404, never
403**, so tokens cannot be enumerated by comparing responses. The guest
projection omits host identity, ledger entries, platform revenue and provider
secrets.

Booking price is always computed server-side from the room's own
`pricePerNight`; a client-supplied `totalAmount` or `nights` is ignored.
Overlapping bookings for the same room are rejected.

---

## HOST and ADMIN authentication

```bash
# Host
curl -X POST localhost:3000/api/host/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"host@example.com","password":"..."}'

# Admin
curl -X POST localhost:3000/api/admin/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@example.com","password":"..."}'
```

Both return `{ token, user }`. Send it as `Authorization: Bearer <token>`.

- Passwords are hashed with **bcrypt, cost 12**. Hashes are never returned.
- Unknown account and wrong password return an **identical** error, so the
  endpoint cannot be used to enumerate accounts.
- A HOST credential is rejected at the admin login and vice versa.
- Emails are normalized to lowercase on write and on lookup.
- Actor identity always comes from the verified JWT — a client-supplied
  `hostId`, `actorId` or `role` is ignored.

Authorization helpers:

```ts
requireAuth()          // any authenticated user
requireRole("HOST")    // HOST only
requireRole("ADMIN")   // ADMIN only
```

The HOST and ADMIN routers apply their guard at **router level**, so a newly
added route cannot forget the check.

### Permissions

**Hosts can:** create/edit/deactivate their own rooms, view bookings for their
own rooms, view their own revenue, request refunds for their own rooms.

**Hosts cannot:** modify payment status, mark a payment PAID, touch another
host's rooms or bookings, view platform revenue, reach admin endpoints.

**Admins can:** manage hosts, rooms, bookings, payments, refunds, the ledger,
platform revenue, and administrative accounts.

---

## Payment architecture

`PaymentService` owns every payment and booking-payment state change:

- payment and booking state transitions
- idempotency of payment creation
- webhook deduplication
- atomic database writes
- ledger consistency
- refund consistency

### Payment states

```text
PENDING → PAID → REFUNDED
PENDING → FAILED → (retry) → PENDING
PENDING → EXPIRED
PENDING → CANCELLED
```

### Booking states

```text
PENDING_PAYMENT → PAID → CONFIRMED → REFUNDED
PENDING_PAYMENT → PAYMENT_FAILED → PENDING_PAYMENT   (retry)
PENDING_PAYMENT → EXPIRED
```

### Money

All amounts are **integer minor units** (rupiah). `Rp825,000` is stored as
`825000`. Floating point is never used for money.

On a successful payment the ledger records four entries whose invariant must
hold exactly:

```text
FULL_PAYMENT = HOST_REVENUE + PLATFORM_REVENUE + GATEWAY_FEE
```

The split is computed with integer arithmetic; rounding remainder goes to the
host so the invariant holds to the rupiah. Commission is controlled by
`PLATFORM_FEE_BPS` (800–1200 = 8%–12%), validated at startup.

Ledger entries and the payment/booking transition are written in **one
transaction**, so a partial write cannot leave money unaccounted for.

### Retry

A booking that fails payment returns to `PENDING_PAYMENT` when a new payment is
created, so a transient provider failure does not strand the guest. `EXPIRED`
is terminal — the guest must create a new booking.

---

## Webhook flow

```text
POST /api/payments/webhook?provider=mock
```

1. **Raw body capture.** The webhook route is mounted *before* `express.json()`
   so the signature is verified over the exact bytes received. Re-serializing
   parsed JSON would change key order and break verification.
2. **Signature verification.** HMAC-SHA256 over the raw body, compared in
   constant time. A forged, missing or mismatched signature is rejected with
   `400 WEBHOOK_ERROR` and **no state is written**.
3. **Provider validation.** The provider must match the payment's provider.
4. **Amount cross-check.** The provider's amount must equal the stored amount.
   A mismatch is rejected and the payment is left untouched.
5. **Deduplication.** `WebhookEvent` has a unique `(provider, eventId)`. A
   replayed event is a no-op.
6. **Atomic application.** Payment state, booking state, ledger entries and the
   notification are written in one transaction.

A webhook for a payment already in a terminal state is acknowledged as an
**idempotent no-op** — it does not raise an error, which would otherwise make
the provider retry forever.

**The frontend can never mark a payment as PAID.** `PAID` is reachable only
through a signature-verified webhook. A client-supplied `status` or `amount` on
any write endpoint is stripped by request validation.

---

## Mock payment gateway

`MockPaymentGateway` simulates a real external provider and follows the **same
contract** future providers will implement:

```ts
interface PaymentGateway {
  readonly name: string;
  createTransaction(input): Promise<CreateTransactionResult>;
  parseWebhook(input): Promise<NormalizedWebhookEvent>;
  refund(input): Promise<RefundResult>;
}
```

It signs webhooks with HMAC-SHA256 (`x-mock-signature: sha256=<hex>`) exactly
as a real provider would, so the verification path exercised in development and
tests is the same one production will use.

The mock checkout page at `/api/mock-payment/:transaction` simulates the
provider's hosted page. It is **gated twice**:

1. It is refused entirely when `NODE_ENV=production`.
2. It requires the booking's tracking token.

This prevents it from being used to self-approve a payment. Selecting
SUCCESS / FAILED / EXPIRED emits a *signed* webhook back to
`${APP_PUBLIC_URL}/api/payments/webhook?provider=mock` — it does **not** bypass
the webhook pipeline.

Adding a real provider: implement `PaymentGateway`, register it in
`src/payment/registry.ts`, and set `PAYMENT_PROVIDER`. Do not bypass
`PaymentService`.

---

## Security considerations

**Transport and headers** — Helmet security headers, `x-powered-by` disabled,
CORS restricted to an explicit allowlist, request body size limit, `trust
proxy` enabled only in production.

**Rate limiting** — separate buckets for authentication (credential stuffing),
booking creation (guest spam) and payment creation. Webhooks are deliberately
*not* IP-limited, because providers retry from changing infrastructure and
dropping a legitimate retry would strand a payment; deduplication is the
correct protection there.

**Input validation** — every route validates with zod. Unknown keys are
stripped, which prevents mass-assignment. Request schemas deliberately omit
`status`, `amount`, `actorId`, `hostId` and `role`.

**Error responses** — one consistent shape:

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "...", "details": [] } }
```

Internal errors return an opaque 500; stack traces and internal messages are
never sent to clients.

**Logging** — structured JSON with a redaction list. Passwords, tokens, API
keys, webhook secrets, authorization headers, card numbers and CVV are replaced
with `[REDACTED]` before output. Request logging records method, path, status
and duration only — never query strings, which can carry tracking tokens.

**Secrets** — never hardcoded. `.env` is gitignored; `.env.example` documents
the required names without values. Startup validation prints variable *names*
only. `git ls-files` should never contain `.env`, `*.db`, `dist/` or
`node_modules/`.

**Guest abuse protection** — rate limiting on booking and payment creation,
cryptographically secure tracking tokens, server-side pricing, overlap
rejection, and input validation. CAPTCHA is intentionally not added until it is
actually required.

**Known limitations** — see `docs/postgresql-migration.md` for the
single-process concurrency note.

### Refund concurrency

A payment has exactly **one refund identity**: `Refund` is unique on
`paymentId` alone. The row is the claim, and only the caller that creates (or
takes over a previously failed) claim may call the provider.

- Concurrent refund requests converge: the loser waits for the winner and
  returns the same result, so the provider is invoked **at most once** per
  refund intent.
- A failed attempt is marked `FAILED` rather than deleted, which keeps the
  identity permanent (no second provider call can slip in) while remaining
  retryable by an operator.
- The claim is never left `PENDING` by a race: it reaches `SUCCEEDED` or
  `FAILED`.

This is covered by `tests/refund.test.ts`, including a spy assertion that the
gateway's `refund` is called exactly once under concurrent load.
