# finora-server

REST API for **Finora AI** — smart personal finance, powered by AI.

Express 5 + TypeScript on Node 22 LTS, PostgreSQL through Prisma, and a provider-agnostic
AI layer. This repository is independent of the SPA (`finora-client`); the only contract
between them is the HTTP API documented in `ARCHITECTURE.md` §7.

The API is the single gateway to the database and to every external service — Gemini/Groq/
OpenRouter, Frankfurter, CoinGecko. No API key is ever exposed to a browser.

## Requirements

- Node.js 22 LTS or newer
- npm 10 or newer

## Setup

```bash
cp .env.example .env      # fill in values — .env is never committed
npm install
npm run db:deploy         # apply migrations (uses DIRECT_URL when set, else DATABASE_URL)
npm run dev               # http://localhost:5000
```

On Supabase, take both connection strings from **Project settings → Database → Connection
pooling**: the direct `db.<ref>.supabase.co` host resolves to IPv6 only, so networks without
IPv6 must use the Supavisor pooler — transaction pooler (port 6543) for `DATABASE_URL`,
session pooler (port 5432) for `DIRECT_URL`, which migrations need.

Verify it is up:

```bash
curl http://localhost:5000/health
```

## Scripts

| Script                 | Purpose                                           |
| ---------------------- | ------------------------------------------------- |
| `npm run dev`          | Watch mode (`tsx watch`)                          |
| `npm run build`        | Generate the Prisma client, compile to `dist/`    |
| `npm start`            | Run the compiled server                           |
| `npm run lint`         | ESLint                                            |
| `npm run lint:fix`     | ESLint with autofix                               |
| `npm run format`       | Prettier write                                    |
| `npm run format:check` | Prettier check (CI)                               |
| `npm run typecheck`    | `tsc --noEmit`                                    |
| `npm test`             | Vitest (unit + Supertest API tests)               |
| `npm run db:generate`  | Regenerate the Prisma client into `src/generated` |
| `npm run db:migrate`   | Create and apply a migration (development)        |
| `npm run db:deploy`    | Apply pending migrations (deployment)             |
| `npm run db:seed`      | Seed a demo user (needs `SEED_DEMO_PASSWORD`)     |
| `npm run db:studio`    | Prisma Studio                                     |

## Environment variables

Names and purposes are defined in `ARCHITECTURE.md` §11 and mirrored in `.env.example`.
The server validates its configuration at boot and refuses to start if a required
variable is missing or malformed.

Required today: `NODE_ENV`, `PORT`, `CLIENT_ORIGIN`, `DATABASE_URL`, `JWT_ACCESS_SECRET`,
`JWT_REFRESH_SECRET` (32+ characters each, and different from one another). `DIRECT_URL` is
optional and used for migrations. The remaining variables are listed in `.env.example` and
become required in the phase that introduces them (AI keys in Phase 10).

Secrets live only in the local `.env` file or the host's environment settings — never in
code, Git, logs, or AI prompts.

## Layout

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

Requests flow `routes → validation → controller → service → Prisma`. Business logic and
all financial math live in services; controllers only handle HTTP. Every response uses the
envelope `{ success: true, data }` or `{ success: false, error: { code, message, details } }`.

## Documentation

The specification lives in the workspace folder alongside this repository:
`AGENTS.md`, `PROJECT_CONTEXT.md`, `ARCHITECTURE.md`, `DEVELOPMENT_RULES.md`,
`IMPLEMENTATION.md`. Read them before changing anything here.

## License

[MIT](LICENSE)
