import { fetchCurrencies, fetchRates } from '../../integrations/frankfurter.client.js';
import { AppError } from '../../lib/app-error.js';

import type { ConvertQuery, RatesQuery } from './currency.validation.js';

/**
 * Currency business logic (Phase 8). This layer holds no data of its own: it shapes the converter's
 * two needs onto the Frankfurter integration, which owns the cache → timeout → retry → typed-failure
 * pipeline (R-E3). All conversion math runs here on the server, never on the client (R-B3). There is
 * no `userId` because ECB reference rates are public data, not user rows.
 */

export interface RatesResult {
  base: string;
  /** The ECB working day the rates belong to, `YYYY-MM-DD`. */
  asOf: string;
  rates: Record<string, number>;
}

export interface ConvertResult {
  result: number;
  rate: number;
  date: string;
}

/** Reference figures are shown to two places; they are informational, not the money-of-record. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Rejects any well-formed code the upstream does not actually list, as a clean 400 rather than
 * letting Frankfurter answer with an error we would otherwise surface as a 503 (ARCHITECTURE.md §7).
 */
async function assertSupported(codes: string[]): Promise<void> {
  const supported = await fetchCurrencies();

  for (const code of codes) {
    if (!(code in supported)) {
      throw new AppError('VALIDATION_ERROR', `${code} is not a supported currency.`, [
        { field: 'currency', message: `${code} is not a supported currency` },
      ]);
    }
  }
}

/** Splits the optional comma-separated `symbols` list into distinct codes, or `undefined`. */
function parseSymbols(symbols: string | undefined): string[] | undefined {
  if (symbols === undefined) {
    return undefined;
  }

  const codes = symbols
    .split(',')
    .map((code) => code.trim().toUpperCase())
    .filter((code) => code.length > 0);

  return codes.length > 0 ? [...new Set(codes)] : undefined;
}

export async function getRates(query: RatesQuery): Promise<RatesResult> {
  const symbols = parseSymbols(query.symbols);

  await assertSupported(symbols === undefined ? [query.base] : [query.base, ...symbols]);

  const fx = await fetchRates(query.base, symbols);

  return { base: fx.base, asOf: fx.date, rates: fx.rates };
}

export async function convert(query: ConvertQuery): Promise<ConvertResult> {
  const { from, to, amount } = query;

  await assertSupported([from, to]);

  // Same currency: the upstream omits the base from its own rates, so short-circuit to 1 and
  // borrow only the reference date from a rates read.
  if (from === to) {
    const { date } = await fetchRates(from);
    return { result: round2(amount), rate: 1, date };
  }

  const { rates, date } = await fetchRates(from, [to]);
  const rate = rates[to];

  // Defensive: a code the currency list accepts but the day's rates omit. Treat as unavailable.
  if (rate === undefined) {
    throw new AppError(
      'UPSTREAM_UNAVAILABLE',
      'Currency rates are unavailable right now. Please try again shortly.',
    );
  }

  return { result: round2(amount * rate), rate, date };
}
