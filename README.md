# Finora AI — Server

The HTTP API for **Finora AI**: the single gateway between the web client and everything sensitive —
the database, the AI providers, and the market-data upstreams.

> **Smart Personal Finance, Powered by AI.**

This repository is the **backend only**. The browser never talks to Prisma, an AI provider, or an
external API directly — it calls this server, and this server is the only place that holds secrets,
runs financial math, and enforces per-user data isolation.

`finora-server` and `finora-client` are independent repositories; their only contract is the HTTP
API described in `ARCHITECTURE.md` §7.

---

## 🎯 Responsibilities

- **Auth & sessions** — register, login, refresh, logout, profile, and password changes, with JWTs
  delivered only in HttpOnly cookies.
- **Financial data** — transactions, categories, budgets, savings goals, and dashboard/analytics
  aggregates, every query scoped to the authenticated user.
- **All money math** — totals, budget usage, and goal progress are computed server-side in SQL; the
  client only formats.
- **AI insights** — reports and Q&A built from aggregate-only context through a provider abstraction,
  never touching the database directly.
- **Reference data** — cached currency (Frankfurter) and crypto (CoinGecko) views behind a
  cache → timeout → retry → typed-failure integration layer.
- **Email verification** — token issuance and confirmation via Resend, gating AI/analytics surfaces.

---

## 🧱 Tech Stack

| Area | Choice |
| --- | --- |
| Runtime | Node.js 22 (`engines.node >= 22`) |
| Framework | Express 5 |
| Language | TypeScript 6 (strict) |
| ORM | Prisma 7 with the `@prisma/adapter-pg` driver adapter |
| Database | PostgreSQL (Supabase in the reference deployment) |
| Validation | Zod 4 |
| Auth | `jsonwebtoken` (JWT) + `bcryptjs` (password hashing) |
| Hardening | `helmet`, `cors`, `express-rate-limit`, `cookie-parser` |
| Testing | Vitest + Supertest |

---

## 🧩 Architecture

Requests flow through fixed layers — business logic lives only in services:

```
routes → validation (Zod) → controller → service → Prisma → PostgreSQL
```

The server is the single gateway:

```
browser → Finora API → ┬─ Prisma / PostgreSQL
                       ├─ AI providers (via AIProvider abstraction)
                       ├─ Frankfurter (currency)
                       └─ CoinGecko (crypto)
```

Source layout:

```
src/
  ai/           AIProvider abstraction + gemini/groq/openrouter/mock providers, provider-config
  config/       env parsing, constants, default categories
  integrations/ coingecko / frankfurter / resend clients (cache → timeout → retry → typed failure)
  lib/          api-response envelope, app-error, auth-cookies, jwt, cache, month-range,
                prisma client & error mapping, shared schemas, search escaping, verification-token
  middleware/   auth, validate, rate-limit, request-logger, error-handler
  modules/      auth, categories, transactions, budgets, goals, dashboard, currency, crypto,
                ai, quotes, health — each with routes / validation / controller / service
  services/     cross-module services (e.g. email)
  app.ts        express app, router mounting, error handling
  index.ts      server bootstrap
prisma/         schema.prisma, migrations, seed
scripts/        smoke.ts (opt-in live smoke check)
```

---

## 🔌 API

All routes are mounted under `/api/v1` and return the shared success/error envelope defined in
`ARCHITECTURE.md` §7. Route groups:

| Group | Mount | Notes |
| --- | --- | --- |
| Auth | `/auth` | `register`, `login`, `refresh`, `verify-email`, `resend-verification` (public, rate-limited); `logout`, `me`, `profile` (PATCH), `change-password` (authenticated) |
| Categories | `/categories` | User-scoped CRUD |
| Transactions | `/transactions` | Filter, sort, paginate; user-scoped |
| Budgets | `/budgets` | Per-category and overall budgets |
| Goals | `/goals` | Savings goals |
| Dashboard | `/dashboard` | Aggregates & analytics (SQL-computed) |
| Currency | `/currency` | Cached Frankfurter reference data |
| Crypto | `/crypto` | Cached CoinGecko reference data |
| AI | `/ai` | Reports & Q&A (requires a verified email) |
| Quotes | `/quotes/:category` | Motivational card for `transactions`/`budgets`/`goals` (auth only, no verified-email gate) |
| Health | `/health` and `/api/v1/health` | Liveness |

Health is also exposed at the top-level `/health` for platform probes.

---

## 🔐 Authentication & Security

- **JWT in HttpOnly cookies only** — never in response bodies or `localStorage`. An access cookie
  (`finora_at`, path `/`) and a refresh cookie (`finora_rt`, path `/api/v1/auth`) are issued;
  `SameSite=Lax`, and `Secure` in production.
- **Password hashing** with `bcryptjs`; a password policy is enforced on registration and change.
- **Per-user isolation** — every query on user-owned tables is scoped by the authenticated `userId`;
  cross-user access returns `404` (existence is never leaked).
- **Input validation** — every request body/params/query is Zod-validated; search input is escaped.
- **Rate limiting** on auth, AI, and external-backed endpoints (`express-rate-limit`).
- **Hardening** — `helmet` headers and a strict `cors` allow-list driven by `CLIENT_ORIGIN`.
- **AI output is untrusted** — validated, capped, and returned as plain text; user questions are
  delimiter-wrapped with anti-injection instructions.

---

## 🗄️ Database

Prisma models (see `prisma/schema.prisma` for the authoritative schema):

| Model | Notes |
| --- | --- |
| `User` | Email (unique, lowercased), password hash, currency, timezone, `tokenVersion`, email-verification fields |
| `Category` | Unique per `(userId, name, type)`; cascades on user delete |
| `Transaction` | `amount` `Decimal(14,2)`, `description` up to 280 chars, `categoryId` set null on category delete, indexed by user & date |
| `Budget` | Per-category or overall (nullable category), by month/year; uniqueness enforced in the service layer |
| `SavingsGoal` | `targetAmount` / `currentAmount` `Decimal`, optional deadline |
| `AIReport` | Report `type`, `content` as JSON |

Money is always `Decimal(14,2)` — never floating point. Aggregates run in SQL, and writes that must
be atomic use `$transaction`.

### Migrations

Prisma 7 keeps connection URLs out of `schema.prisma`; the runtime uses the `PrismaPg` adapter and
migrations resolve the URL via `prisma.config.ts`.

```bash
npm run db:generate   # prisma generate
npm run db:migrate    # prisma migrate dev   (local: create & apply a migration)
npm run db:deploy     # prisma migrate deploy (prod: apply committed migrations, forward-only)
npm run db:studio     # Prisma Studio
```

Never edit generated migrations by hand, and never run `db push` against a real database.

### Seed / demo data

```bash
npm run db:seed       # prisma db seed → prisma/seed.ts
```

Seeding provisions a **development-only** demo user. It is driven by `SEED_DEMO_EMAIL` /
`SEED_DEMO_PASSWORD`; no demo password ships in the repo — set one locally to seed. Do not seed
production.

---

## 🤖 AI Architecture

- **Provider abstraction.** Feature code depends on an `AIProvider` interface, never a concrete SDK.
  Implementations: **Gemini**, **Groq**, **OpenRouter**, and a **mock**. `AI_PROVIDER` selects one at
  runtime (the mock is used under test).
- **Aggregate-only context.** The analysis service builds context from user aggregates — no raw
  transactions and no PII beyond aggregates ever reach a provider.
- **Structured & validated output.** Provider responses use JSON mode → Zod validation → one repair
  retry → `503 AI_UNAVAILABLE` on failure. Output is rendered as plain text only.
- **Guardrails.** Every AI response carries an "informational, not financial advice" disclaimer, and
  reports are persisted as `AIReport` rows.
- **Quotas.** Per-user hourly/daily caps (`AI_HOURLY_LIMIT` / `AI_DAILY_LIMIT`), 24h report reuse,
  and a 20s provider timeout.
- **Motivational quotes** (`/quotes/:category`) reuse the AI layer for a short decorative card and
  fall back to curated text when generation is unavailable (`source: "ai" | "fallback"`).

Providers are always mocked in automated tests — CI never calls a metered free tier.

---

## ✉️ Email Verification

- New accounts can use core pages immediately but are gated out of AI/analytics until verified.
- A verification token is issued on registration and re-issuable via `resend-verification`; only a
  hash of the token is stored, with an expiry.
- Confirmation happens through `verify-email`; the client link target is built from `FRONTEND_URL`
  (falling back to the first `CLIENT_ORIGIN`).
- Delivery is handled by **Resend** through the integration layer.

---

## 🌐 External Integrations

Every integration lives in `src/integrations/` and passes through cache → timeout → retry → typed
failure, so an upstream outage degrades gracefully instead of breaking core flows.

| Integration | Used for | Key required |
| --- | --- | --- |
| PostgreSQL / Supabase | Primary datastore | Yes (`DATABASE_URL`, `DIRECT_URL`) |
| Resend | Verification email delivery | Yes (`RESEND_API_KEY`, `RESEND_FROM_EMAIL`) |
| Gemini / Groq / OpenRouter | AI generation (one active via `AI_PROVIDER`) | Provider key for the active provider |
| CoinGecko | Crypto reference data | Optional (`COINGECKO_API_KEY`) |
| Frankfurter | Currency reference data | No key |

Currency and crypto data are cached reference values — never described as real-time.

---

## ⚙️ Environment Variables

All configuration is server-side. **Secrets belong only in server env vars** — never in code, Git,
logs, the client bundle, or AI prompts. Copy `.env.example` (the authoritative list) to `.env`.

**Runtime**

| Variable | Notes |
| --- | --- |
| `NODE_ENV` | `development` / `production` / `test` |
| `PORT` | Default `5000`; the host injects this in production |
| `CLIENT_ORIGIN` | Comma-separated CORS allow-list |

**Database**

| Variable | Notes |
| --- | --- |
| `DATABASE_URL` | Pooled connection (Supabase pooler, port 6543) |
| `DIRECT_URL` | Direct connection for migrations (port 5432); falls back to `DATABASE_URL` |

**Auth (secrets)**

| Variable | Notes |
| --- | --- |
| `JWT_ACCESS_SECRET` | ≥ 32 bytes; distinct from the refresh secret |
| `JWT_REFRESH_SECRET` | ≥ 32 bytes; distinct from the access secret |

**AI**

| Variable | Notes |
| --- | --- |
| `AI_PROVIDER` | `gemini` \| `groq` \| `openrouter` \| `mock` (default `gemini`; `mock` under test) |
| `GEMINI_API_KEY` / `GROQ_API_KEY` / `OPENROUTER_API_KEY` | Secret for the active provider |
| `AI_HOURLY_LIMIT` / `AI_DAILY_LIMIT` | Per-user quotas (defaults `15` / `50`) |

**Market data & email**

| Variable | Notes |
| --- | --- |
| `COINGECKO_API_KEY` | Optional |
| `RESEND_API_KEY` | Secret |
| `RESEND_FROM_EMAIL` | Verified sender |
| `FRONTEND_URL` | Base for verification links; falls back to first `CLIENT_ORIGIN` |

**Seed (development)**

| Variable | Notes |
| --- | --- |
| `SEED_DEMO_EMAIL` | Demo user email (default `demo@finora.local`) |
| `SEED_DEMO_PASSWORD` | Set locally to seed; blank by default (nothing ships) |

---

## 🚀 Local Development

Requires Node 22 (see `.node-version`) and a reachable PostgreSQL database.

```bash
npm install
cp .env.example .env       # then fill in the values above
npm run db:generate        # generate the Prisma client
npm run db:migrate         # apply migrations to your local database
npm run db:seed            # optional: seed a dev demo user (set SEED_DEMO_PASSWORD first)
npm run dev                # tsx watch on http://localhost:5000
```

---

## 🧪 Testing & Quality

```bash
npm run test          # vitest run (unit + Supertest integration)
npm run test:coverage # with coverage
npm run typecheck     # tsc, no emit
npm run lint          # ESLint
npm run format        # Prettier write
npm run smoke         # tsx scripts/smoke.ts — opt-in live smoke check (not part of CI)
```

AI and external providers are always mocked in automated tests; the mock AI provider is used under
test, so the suite never calls a metered free tier. The `smoke` script is an intentional, opt-in
check against live configuration and is not run in CI.

---

## ☁️ Production Deployment (Render)

The reference deployment runs as a **Render** web service (`render.yaml`):

- **Build:** `npm ci --include=dev && npm run build && npm run db:deploy`
- **Start:** `npm start` (`node dist/index.js`)
- **Health check path:** `/health`
- **Port:** injected via `PORT` — the app binds to it.
- **`CLIENT_ORIGIN`** must include the deployed SPA origin so CORS and cookies work.

`build` runs `prisma generate && tsc -p tsconfig.build.json`; `db:deploy` applies committed
migrations forward-only. Free-tier web services cold-start after idle — the first request after a
sleep may be slow. Confirm current free-tier terms before deploying.

---

## 💓 Health Check

```bash
curl http://localhost:5000/health
```

Returns a small JSON payload (status, uptime, timestamp) suitable for a platform liveness probe. The
same endpoint is also available under `/api/v1/health`.

---

## 🐛 Troubleshooting

| Symptom | Likely cause / fix |
| --- | --- |
| Server won't start | Missing/invalid env vars — the env parser fails fast. Check `.env` against `.env.example`. |
| Migrations fail | `DIRECT_URL` unreachable or pointing at the pooler. Migrations need the direct (5432) connection. |
| CORS / cookie errors | The SPA origin isn't in `CLIENT_ORIGIN`, or the request is cross-site. Keep the client same-origin via its `/api` rewrite. |
| `AI_UNAVAILABLE` (503) | Provider key missing/invalid, quota hit, or the response failed validation after one repair retry. |
| `429` responses | A rate limit was reached on auth/AI/external-backed routes. |
| Slow first request in prod | Free-tier cold start after idle. |

---

## 🧭 Development Guidelines

This repository is governed by the workspace specification docs — read them before contributing:
`AGENTS.md`, `PROJECT_CONTEXT.md`, `ARCHITECTURE.md`, `DEVELOPMENT_RULES.md`, and
`IMPLEMENTATION.md`. Key invariants: layered routes → service → Prisma, per-user `userId` scoping,
server-side money math, secrets only in env vars, and AI that never touches the database.

---

## 📄 License

Released under the [MIT License](./LICENSE).







