/**
 * Live provider smoke test (R-E5, R-T4) — the deliberate opposite of CI.
 *
 * `npm test` NEVER touches an external service: the AI providers and the Frankfurter/CoinGecko
 * clients are mocked, so the suite is deterministic and free (R-T4). That proves the *contract*
 * around each integration — request construction, response parsing, validation, timeout/retry, and
 * the typed-failure fallbacks — but it can NOT prove that a real provider is reachable or that a
 * configured model still exists on a free tier, because those live outside this repository and
 * change without notice.
 *
 * This script closes that gap on demand. It makes REAL calls to the configured services and is
 * meant to be run by a human at deploy time (Phase 18) or whenever provider config changes — never
 * as part of CI. It requires a bootable server `.env`; the `ai` check additionally requires the
 * selected provider's key. No secret is ever printed: only provider name, endpoint, model, and
 * status. Any requested check that fails sets a non-zero exit code.
 *
 *   npm run smoke                    # all three: currency, crypto, ai
 *   npm run smoke -- currency        # a subset (e.g. skip ai when no key is configured)
 *   npm run smoke -- currency crypto
 */

import { z } from 'zod';

import { generateStructured, resolveProviderName } from '../src/ai/ai.service.js';
import {
  AI_PROVIDER_ENDPOINTS,
  isLiveProvider,
  isProviderKeyConfigured,
} from '../src/ai/provider-config.js';
import { fetchTopMarkets } from '../src/integrations/coingecko.client.js';
import { fetchCurrencies, fetchRates } from '../src/integrations/frankfurter.client.js';

type CheckName = 'currency' | 'crypto' | 'ai';
const ALL_CHECKS: readonly CheckName[] = ['currency', 'crypto', 'ai'];

interface CheckResult {
  readonly status: 'pass' | 'fail';
  readonly detail: string;
}

/** Human-readable output only; `no-console` (R-L1) forbids `console`, so write straight to stdout. */
function line(text = ''): void {
  process.stdout.write(`${text}\n`);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}

// PLACEHOLDER_CHECKS
/** Frankfurter needs no key: fetch the currency list and one live reference rate. */
async function checkCurrency(): Promise<CheckResult> {
  const currencies = await fetchCurrencies();
  const rates = await fetchRates('USD', ['EUR']);
  const eur = rates.rates.EUR;
  if (eur === undefined) {
    return { status: 'fail', detail: 'Frankfurter returned no EUR rate for base USD' };
  }
  return {
    status: 'pass',
    detail: `${String(Object.keys(currencies).length)} currencies; USD→EUR ${String(eur)} as of ${rates.date} (reference, not real-time)`,
  };
}

/** CoinGecko's keyless free tier: fetch the first page of top markets. */
async function checkCrypto(): Promise<CheckResult> {
  const coins = await fetchTopMarkets(1);
  const first = coins[0];
  if (first === undefined) {
    return { status: 'fail', detail: 'CoinGecko returned an empty markets page' };
  }
  const price = first.price === null ? 'n/a' : String(first.price);
  return {
    status: 'pass',
    detail: `${String(coins.length)} coins; top is ${first.name} (${first.symbol}) at ${price} USD (reference, not real-time)`,
  };
}

/**
 * The configured AI provider, exercised through the real `generateStructured` pipeline
 * (JSON → Zod → repair → typed failure). Fails clearly when the provider is `mock` or its key is
 * unset; on an upstream rejection the AI Service's own log line carries the safe reason.
 */
async function checkAi(): Promise<CheckResult> {
  const name = resolveProviderName();
  if (!isLiveProvider(name)) {
    return {
      status: 'fail',
      detail:
        "AI_PROVIDER resolves to 'mock'; set AI_PROVIDER to gemini|groq|openrouter for a live check",
    };
  }

  const cfg = AI_PROVIDER_ENDPOINTS[name];
  if (!isProviderKeyConfigured(name)) {
    return {
      status: 'fail',
      detail: `${cfg.keyEnvVar} is not set — cannot make a live ${name} call`,
    };
  }

  const result = await generateStructured('smoke-test', {
    system: 'You are a JSON API. Reply with ONLY a JSON object and nothing else.',
    user: 'Return exactly {"status":"ok"}.',
    schema: z.object({ status: z.string() }),
    maxTokens: 64,
  });

  const tokens = result.usage.outputTokens ?? 0;
  return {
    status: 'pass',
    detail: `${name} (${cfg.model} @ ${cfg.endpoint}) replied with valid JSON {status:"${result.data.status}"}; ~${String(tokens)} output tokens`,
  };
}

const RUNNERS: Record<CheckName, () => Promise<CheckResult>> = {
  currency: checkCurrency,
  crypto: checkCrypto,
  ai: checkAi,
};

// PLACEHOLDER_MAIN
/** Returns the checks to run, or an error string when an argument names an unknown check. */
function parseChecks(argv: readonly string[]): CheckName[] | string {
  if (argv.length === 0) {
    return [...ALL_CHECKS];
  }
  const selected: CheckName[] = [];
  for (const arg of argv) {
    const match = ALL_CHECKS.find((check) => check === arg);
    if (match === undefined) {
      return `unknown check "${arg}" (expected: ${ALL_CHECKS.join(', ')})`;
    }
    selected.push(match);
  }
  return selected;
}

async function main(): Promise<void> {
  const parsed = parseChecks(process.argv.slice(2));
  if (typeof parsed === 'string') {
    process.stderr.write(`smoke: ${parsed}\n`);
    process.exitCode = 1;
    return;
  }

  line('Finora live provider smoke test — real external calls, never part of CI.');
  line(`Configured AI provider (from env): ${resolveProviderName()}`);
  line('');

  let failures = 0;
  for (const name of parsed) {
    let result: CheckResult;
    try {
      result = await RUNNERS[name]();
    } catch (error) {
      result = { status: 'fail', detail: messageOf(error) };
    }
    if (result.status === 'fail') {
      failures += 1;
    }
    line(`[${result.status.toUpperCase()}] ${name}: ${result.detail}`);
  }

  line('');
  if (failures > 0) {
    line(`${String(failures)} check(s) failed.`);
    process.exitCode = 1;
    return;
  }
  line('All requested checks passed.');
}

void main();
