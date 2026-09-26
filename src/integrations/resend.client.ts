import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

/**
 * Resend transactional-email client (email-verification phase). The browser never talks to Resend;
 * the server is the only gateway (R-E4), and this is the only module that knows Resend's HTTP shape
 * (R-E1). It follows the same R-E3 pipeline as the other integrations — timeout → one retry →
 * typed failure — minus caching, which is meaningless for a send.
 *
 * The API key is read ONLY from `env` and travels ONLY in the Authorization header; it is NEVER
 * logged, returned, or included in an error (R-A4). Failures surface as a typed `ResendError` with
 * a status but no provider body, so the caller can degrade gracefully without leaking upstream
 * detail. Delivery runs against the free tier; sending is not "real-time" is irrelevant here, but
 * the free-tier limits and verified-sender requirement are documented in `.env.example` (R-E5).
 */

const SEND_URL = 'https://api.resend.com/emails';
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 2; // one retry
const RETRY_BASE_DELAY_MS = 300;

/** A single outbound message. `html` is the rendered body; a plain-text part is optional. */
export interface ResendMessage {
  to: string;
  subject: string;
  html: string;
}

/** A typed send failure. `retryable` separates a transient upstream hiccup from a hard rejection. */
export class ResendError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ResendError';
  }
}

/**
 * Whether Resend is wired up. Registration checks this so a deployment with no email configured
 * still creates accounts (soft gate) instead of erroring — the send is simply skipped and logged.
 */
export function isResendConfigured(): boolean {
  return (
    env.RESEND_API_KEY !== undefined &&
    env.RESEND_API_KEY.length > 0 &&
    env.RESEND_FROM_EMAIL !== undefined &&
    env.RESEND_FROM_EMAIL.length > 0
  );
}

/** 429 and 5xx are worth a retry; a 4xx (bad sender, invalid key) will fail the same way again. */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** One POST with a hard timeout. A non-2xx becomes a typed, maybe-retryable failure. */
async function sendOnce(apiKey: string, from: string, message: ResendMessage): Promise<void> {
  const response = await fetch(SEND_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: message.to,
      subject: message.subject,
      html: message.html,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    // The provider body may echo the request; we read the status only and never propagate it, so no
    // recipient address or key material can leak through an error message (R-A4).
    throw new ResendError(
      `resend responded ${String(response.status)}`,
      isRetryableStatus(response.status),
      response.status,
    );
  }
}

/**
 * Sends one email through Resend, retrying once on a transient failure. Throws `ResendError` when
 * the send ultimately fails or when Resend is not configured — callers decide whether that is fatal
 * (it is not, for registration). The key and sender come from `env`; nothing sensitive is logged.
 */
export async function sendEmail(message: ResendMessage): Promise<void> {
  if (!isResendConfigured()) {
    throw new ResendError('resend is not configured', false);
  }

  // Narrowed by isResendConfigured(); the non-null assertions are safe.
  const apiKey = env.RESEND_API_KEY as string;
  const from = env.RESEND_FROM_EMAIL as string;

  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      await sendOnce(apiKey, from, message);
      return;
    } catch (error) {
      lastError = error;
      // A network/timeout error carries no status, so treat it as transient and retry once.
      const retryable = error instanceof ResendError ? error.retryable : true;

      if (attempt < MAX_ATTEMPTS && retryable) {
        await delay(RETRY_BASE_DELAY_MS * attempt);
        continue;
      }

      break;
    }
  }

  const status = lastError instanceof ResendError ? lastError.status : undefined;
  // Status only — never the recipient, subject, key, or provider body (R-A4).
  logger.warn('resend_send_failed', { status: status ?? null });
  throw lastError instanceof ResendError
    ? lastError
    : new ResendError('resend request failed', true);
}
