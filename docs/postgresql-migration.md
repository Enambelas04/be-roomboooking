# SQLite → PostgreSQL Migration

Development runs on SQLite. Production targets PostgreSQL. The Prisma schema is
kept PostgreSQL-ready, but **the migration is not performed automatically** —
it is a deliberate, reviewed operation.

---

## 1. Prisma datasource configuration

`prisma/schema.prisma` currently declares:

```prisma
datasource db {
  provider = "sqlite"
  url      = env("DATABASE_URL")
}
```

For PostgreSQL, change **only the provider**:

```prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
```

Keep it driven by `env("DATABASE_URL")` so no connection string is ever
committed.

---

## 2. DATABASE_URL

SQLite (development):

```env
DATABASE_URL="file:./dev.db"
```

PostgreSQL (production):

```env
DATABASE_URL="postgresql://USER:PASSWORD@HOST:5432/DATABASE?schema=public&sslmode=require"
```

Notes:

- Put this in `.env` locally and in the platform's secret store in production.
- **Never commit a real connection string.** `.env` is gitignored; only
  `.env.example` (names, no values) is tracked.
- Use `sslmode=require` for managed providers.
- URL-encode special characters in the password (`@` → `%40`, `:` → `%3A`).

---

## 3. Enums

SQLite has no native enum type, so status and role columns are stored as
`String` and validated in the service layer against
`src/domain/statuses.ts`.

On PostgreSQL you may re-introduce native enums for stronger database-level
guarantees:

```prisma
enum BookingStatus {
  PENDING_PAYMENT
  PAID
  CONFIRMED
  PAYMENT_FAILED
  EXPIRED
  REFUNDED
  CANCELLED
}

model Booking {
  status BookingStatus @default(PENDING_PAYMENT)
}
```

The existing string values were chosen to match the enum members exactly, so
the data maps across without rewriting rows. This step is **optional** —
converting a populated column to an enum requires a migration that casts the
values, so test it against a restored production snapshot first.

---

## 4. JSON fields

`WebhookEvent.payload` and `PaymentEvent.payload` are `String` holding
JSON-encoded text. PostgreSQL supports a native `Json` type:

```prisma
model WebhookEvent {
  payload Json
}
```

If you switch, the application code that currently calls `JSON.stringify` /
`JSON.parse` on those fields must be updated in the same change. Keeping them
as `String` is fully valid and requires no code change.

---

## 5. Migration workflow

Prisma's migration history is provider-specific: the existing `migration.sql`
files contain SQLite DDL and **cannot be replayed against PostgreSQL**. Choose
one of these paths.

### Option A — fresh baseline (recommended for a new deployment)

```bash
# 1. Point DATABASE_URL at the PostgreSQL database
# 2. Switch the provider in schema.prisma
# 3. Remove the SQLite migration history (it is dev-only history)
rm -rf prisma/migrations

# 4. Create a PostgreSQL baseline migration
npx prisma migrate dev --name init_postgres

# 5. Apply to the production database
npx prisma migrate deploy
```

### Option B — preserve history

Keep the existing migrations for SQLite development and maintain a **separate**
branch or directory of PostgreSQL migrations. This is more work and is only
worth it if the SQLite history must remain authoritative for other developers.

### Validate before applying

```bash
npx prisma validate
npx prisma migrate diff \
  --from-url "$DATABASE_URL" \
  --to-schema-datamodel prisma/schema.prisma \
  --script
```

Review the generated SQL before running it against anything real.

**Do not perform a destructive migration automatically.** Take a backup first:

```bash
pg_dump "$DATABASE_URL" > backup-$(date +%F-%H%M).sql
```

### Migrating existing data

If you need to move data rather than start empty, export and re-import per
table in foreign-key order:

```text
User → Room → Booking → Payment → PaymentEvent → WebhookEvent
     → Refund → LedgerEntry → Notification
```

Preserve primary keys and all monetary integers exactly. Verify the ledger
invariant after import:

```sql
-- Must return no rows: every payment's split must equal its FULL_PAYMENT.
SELECT paymentId
FROM "LedgerEntry"
GROUP BY paymentId
HAVING
  SUM(CASE WHEN type = 'HOST_REVENUE'     THEN amount ELSE 0 END)
+ SUM(CASE WHEN type = 'PLATFORM_REVENUE' THEN amount ELSE 0 END)
+ SUM(CASE WHEN type = 'GATEWAY_FEE'      THEN amount ELSE 0 END)
<> SUM(CASE WHEN type = 'FULL_PAYMENT'    THEN amount ELSE 0 END);
```

---

## 6. Production considerations

**Connection pooling.** Serverless platforms open many short-lived
connections. Use a pooler (PgBouncer, Supabase pooler, Neon pooled endpoint)
and append `?pgbouncer=true&connection_limit=1` when required by the provider.

**Migrations in deployment.** Run `npx prisma migrate deploy` as a release step,
never `migrate dev` — the latter is interactive and may reset data.

**Backups.** Enable automated backups and verify a restore before going live.

**Transactions.** PostgreSQL gives real isolation, which removes the
single-process assumptions noted below.

**Indexes.** The schema already indexes the hot paths (`Booking` by room and
date range, `Payment` by booking/status, `LedgerEntry` by payment and type,
`WebhookEvent` unique on provider+eventId). Review with `EXPLAIN ANALYZE` under
real load.

### Concurrency note (important)

Booking creation currently serializes per room **in process**
(`src/lib/roomLock.ts`) and re-checks overlap inside the transaction. That is
correct for a single application instance. **On PostgreSQL with multiple
instances, add a database-level guard**, because the in-process lock does not
span processes:

- `SELECT ... FOR UPDATE` on the room row before the overlap check, or
- an exclusion constraint on the booking date range (`btree_gist` +
  `EXCLUDE USING gist`).

The same applies to refund claiming: PostgreSQL's stronger isolation and
row-level locking make the current claim-then-verify sequence safer, but the
refund path should be re-reviewed as part of this migration.

### Refund uniqueness change

Migration `20261005083623_refund_unique_per_payment` replaced the
`Refund(paymentId, status)` unique constraint with a unique constraint on
`paymentId` alone.

**Why:** with `status` in the key, the claim slot was released as soon as the
winning refund moved from `PENDING` to `SUCCEEDED`. A slow concurrent caller
could then insert a second `PENDING` row and invoke the payment provider a
second time — a real double-refund risk. Keying on `paymentId` alone makes the
refund identity permanent for the payment's lifetime.

**Impact:** a payment may now have at most one `Refund` row, in any status.
A failed attempt stays `FAILED` and is retried by taking over that same row,
rather than by inserting a new one. If you have existing data with multiple
refund rows per payment, resolve it before applying this migration — the
`CREATE UNIQUE INDEX` will fail on duplicates.

---

## 7. Checklist

- [ ] `DATABASE_URL` set in the secret store, not in the repo
- [ ] `provider = "postgresql"` in `prisma/schema.prisma`
- [ ] Backup taken (`pg_dump`)
- [ ] `npx prisma validate` passes
- [ ] Migration SQL reviewed via `migrate diff`
- [ ] `npx prisma migrate deploy` run as a release step
- [ ] Data (if any) re-imported in FK order
- [ ] Ledger invariant query returns no rows
- [ ] Multi-instance concurrency guard added for bookings and refunds
- [ ] `npm test` passes against the migrated schema
