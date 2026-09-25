<div align="center">

# 🪙 Finora AI — Server

### REST API for smart, AI-powered personal finance

**Express 5 · TypeScript · PostgreSQL + Prisma · JWT · Zod**

[![Node](https://img.shields.io/badge/Node.js-22_LTS-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.0-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Express](https://img.shields.io/badge/Express-5.2-000000?logo=express&logoColor=white)](https://expressjs.com)
[![Prisma](https://img.shields.io/badge/Prisma-7.10-2D3748?logo=prisma&logoColor=white)](https://www.prisma.io)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-Supabase-4169E1?logo=postgresql&logoColor=white)](https://supabase.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

</div>

---

The **single gateway** for Finora AI: the browser talks only to this API, and this API is the
only thing that touches the database, the AI providers (Gemini / Groq / OpenRouter), and the
market-data services (Frankfurter, CoinGecko). **No API key ever reaches a browser, and no
financial math ever leaves the server.**

This repository is independent of the SPA ([`finora-client`](../client)); the only contract
between them is the HTTP API documented in `ARCHITECTURE.md` §7.

## ✨ Highlights

- 🔐 **Cookie-based auth** — JWTs live in HttpOnly cookies, never in JavaScript; silent refresh on 401.
- 🧮 **Money is exact** — every amount is `Decimal(14,2)`; aggregates run in SQL, never in floats.
- 🧱 **Strict layering** — `routes → validation → controller → service → Prisma`, enforced by convention.
- 🛡️ **Defense in depth** — Helmet, CORS allow-list, per-route rate limits, and Zod validation on every input.
- 👤 **Airtight tenancy** — every query is scoped by the authenticated `userId`; cross-user access returns `404`, never leaking existence.
- 🤝 **Provider-agnostic AI** — feature code depends on an `AIProvider` interface, never a concrete vendor.
- 📦 **One envelope** — every response is `{ success, data }` or `{ success, error: { code, message, details } }`.

## 🧰 Tech stack

| Concern | Choice |
| --- | --- |
| Runtime | Node.js 22 LTS, ES modules |
| Framework | Express 5 |
| Language | TypeScript 6 (strict) |
| Database | PostgreSQL (Supabase free tier) |
| ORM | Prisma 7 with the `pg` adapter |
| Validation | Zod 4 |
| Auth | `jsonwebtoken` + `bcryptjs`, HttpOnly cookies |
| Hardening | Helmet, `cors`, `express-rate-limit` |
| Tests | Vitest + Supertest |

## 🚀 Getting started

**Prerequisites:** Node.js 22 LTS+ and npm 10+, plus a PostgreSQL database (a free Supabase project works well).

```bash
cp .env.example .env      # fill in values — .env is never committed
npm install
npm run db:deploy         # apply migrations (uses DIRECT_URL when set, else DATABASE_URL)
npm run dev               # http://localhost:5000
```

Confirm it is up:

```bash
curl http://localhost:5000/health
```

> **Supabase note.** Take both connection strings from **Project settings → Database → Connection
> pooling**. The direct `db.<ref>.supabase.co` host resolves to IPv6 only, so networks without IPv6
> must use the Supavisor pooler — transaction pooler (`:6543`) for `DATABASE_URL`, session pooler
> (`:5432`) for `DIRECT_URL`, which migrations need.

### Production

Compile once, then run the compiled server with `NODE_ENV=production`:

```bash
npm ci                    # reproducible install from the lockfile
cp .env.example .env      # or set these as host environment variables
npm run db:deploy         # apply migrations to the production database
npm run build             # prisma generate + tsc → dist/
NODE_ENV=production npm start
```

With `NODE_ENV=production` the server sets **Secure** auth cookies, restricts CORS to the
`CLIENT_ORIGIN` allowlist, and trusts the first proxy hop (`trust proxy`, 1) so it reads the real
client IP and protocol from `X-Forwarded-*` behind the host's TLS terminator (Render). Set
`CLIENT_ORIGIN` to the deployed SPA origin(s), comma-separated.

## 📜 Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Watch mode (`tsx watch`) |
| `npm run build` | Generate the Prisma client, compile to `dist/` |
| `npm start` | Run the compiled server |
| `npm test` | Vitest (unit + Supertest API tests) — deterministic, all external services mocked |
| `npm run smoke` | **Live** provider check (real Frankfurter / CoinGecko / AI calls) — opt-in, never CI; needs a bootable `.env`, and the `ai` check needs the configured provider's key. Subset: `npm run smoke -- currency crypto`. See `IMPLEMENTATION.md` (Phase 10). |
| `npm run lint` / `lint:fix` | ESLint (with autofix) |
| `npm run format` / `format:check` | Prettier write / check (CI) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run db:generate` | Regenerate the Prisma client into `src/generated` |
| `npm run db:migrate` | Create and apply a migration (development) |
| `npm run db:deploy` | Apply pending migrations (deployment) |
| `npm run db:seed` | Seed a demo user (needs `SEED_DEMO_PASSWORD`) |
| `npm run db:studio` | Prisma Studio |

## 🔑 Environment variables

Names and purposes are defined in `ARCHITECTURE.md` §11 and mirrored in `.env.example`. The
server **validates its configuration at boot** and refuses to start if a required variable is
missing or malformed.

Required today: `NODE_ENV`, `PORT`, `CLIENT_ORIGIN`, `DATABASE_URL`, `JWT_ACCESS_SECRET`, and
`JWT_REFRESH_SECRET` (32+ characters each, and different from one another). `DIRECT_URL` is
optional and used for migrations. The remaining variables live in `.env.example` and become
required in the phase that introduces them (AI keys in Phase 10).

Set `NODE_ENV=production` when deploying: it turns on Secure cookies and `trust proxy` and keeps
CORS pinned to the `CLIENT_ORIGIN` allowlist (see [Production](#production) above).

> Secrets live only in the local `.env` file or the host's environment settings — **never** in
> code, Git, logs, or AI prompts.

## 🗂️ Project layout

```
src/
├── index.ts        bootstrap: start the listener, close Prisma on shutdown
├── app.ts          express app factory: middleware chain, routes
├── config/         Zod-validated env loader, shared constants, category catalog
├── generated/      Prisma client output — generated, git-ignored, never edited
├── lib/            logger, AppError, response envelope, Prisma client, JWT, cookies
├── middleware/     request logger, rate limiters, auth guard, validation, errors
├── modules/        one folder per domain:
│                   <domain>.routes.ts → <domain>.controller.ts → <domain>.service.ts
└── types/          ambient declarations (e.g. `Request.userId`)
prisma/             schema.prisma, migrations/, seed.ts
prisma.config.ts    Prisma 7 config: schema path, migrations, connection string
tests/              Vitest + Supertest suites
```

Requests flow `routes → validation → controller → service → Prisma`. Business logic and all
financial math live in **services**; controllers only handle HTTP.

```
Browser ──HTTP──▶ Finora API ──┬──▶ Prisma ──▶ PostgreSQL
   (cookies)                   ├──▶ AI providers (Gemini / Groq / OpenRouter)
                               └──▶ Frankfurter · CoinGecko
```

## ✅ Status & roadmap

Built in sequential phases (see `IMPLEMENTATION.md`). The full API surface is shipped:

| Area | Endpoints | Status |
| --- | --- | --- |
| Auth & sessions | `/auth/*` (register, login, me, refresh, logout) | ✅ |
| Categories | `/categories` CRUD | ✅ |
| Transactions | `/transactions` CRUD, filter, paginate, totals | ✅ |
| Dashboard | `/dashboard/summary`, `/dashboard/analytics` | ✅ |
| Budgets | `/budgets` CRUD with server-computed progress & status | ✅ |
| Savings goals | `/savings-goals` CRUD with server-computed progress | ✅ |
| Currency & crypto | `/currency`, `/crypto` (cached, reference data — never real-time) | ✅ |
| AI insights & Q&A | `/ai/*` (reports + financial Q&A, aggregates only) | ✅ |

Continuous integration runs on every push and pull request
(`.github/workflows/ci.yml`): **lint → typecheck → test**, deterministic and offline (no
database, no external calls, no secrets — Prisma and every provider are mocked, R-T4).

## 📚 Documentation

The specification is the source of truth and lives in the workspace folder alongside this
repository — read it before changing anything here:

- `AGENTS.md` — how to work on the project
- `PROJECT_CONTEXT.md` — product scope and free-tier facts
- `ARCHITECTURE.md` — system design, DB schema, and the API contract (§7)
- `DEVELOPMENT_RULES.md` — enforceable MUST/NEVER rules
- `IMPLEMENTATION.md` — phase plan and completion criteria

## 📄 License

[MIT](LICENSE)

