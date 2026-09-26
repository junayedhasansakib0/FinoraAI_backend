import { VERIFICATION_TOKEN_TTL_MS } from '../config/constants.js';
import { env } from '../config/env.js';
import { sendEmail } from '../integrations/resend.client.js';

/**
 * Email service (email-verification phase). It owns the *content* of the verification email — the
 * branded template and the link — and delegates the *transport* to the Resend client, so auth logic
 * never touches Resend directly (R-E1, task decoupling requirement). Auth calls
 * `sendVerificationEmail(...)` and decides for itself whether a failure is fatal (it is not — the
 * account is still created, soft gate). Neither the token nor the built link is ever logged (R-A4).
 */

const APP_NAME = 'Finora AI';
const VERIFICATION_TTL_HOURS = Math.round(VERIFICATION_TOKEN_TTL_MS / (60 * 60 * 1000));

/** The frontend origin links point at: the explicit `FRONTEND_URL`, else the first CORS origin. */
function frontendOrigin(): string {
  return env.FRONTEND_URL ?? env.CLIENT_ORIGIN[0] ?? '';
}

/**
 * The verification link the user clicks. The token rides as a query parameter the `/verify-email`
 * page reads and posts back. `encodeURIComponent` guards the query even though a base64url token
 * carries no reserved characters.
 */
export function buildVerificationUrl(token: string): string {
  return `${frontendOrigin()}/verify-email?token=${encodeURIComponent(token)}`;
}

/** Minimal, self-contained branded HTML. Inline styles only — email clients ignore <style>/CDN. */
function renderVerificationEmail(url: string): string {
  return `<!doctype html>
<html lang="en">
  <body style="margin:0;background:#f5f4f0;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1c1b18;">
    <div style="max-width:520px;margin:0 auto;padding:40px 24px;">
      <div style="background:#ffffff;border-radius:12px;padding:40px 32px;">
        <p style="margin:0 0 24px;font-size:20px;font-weight:600;letter-spacing:-0.01em;">${APP_NAME}</p>
        <h1 style="margin:0 0 16px;font-size:24px;line-height:1.3;">Verify your email</h1>
        <p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#44413b;">
          Thanks for creating a ${APP_NAME} account. Confirm this is your email address to finish
          setting things up.
        </p>
        <a href="${url}" style="display:inline-block;background:#1c1b18;color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;padding:12px 24px;border-radius:8px;">
          Verify email
        </a>
        <p style="margin:24px 0 8px;font-size:13px;line-height:1.6;color:#6b675f;">
          Or paste this link into your browser:
        </p>
        <p style="margin:0 0 24px;font-size:13px;line-height:1.6;word-break:break-all;">
          <a href="${url}" style="color:#3f5f8f;">${url}</a>
        </p>
        <p style="margin:0 0 8px;font-size:13px;line-height:1.6;color:#6b675f;">
          This link expires in ${String(VERIFICATION_TTL_HOURS)} hours.
        </p>
        <p style="margin:0;font-size:13px;line-height:1.6;color:#6b675f;">
          If you did not create a ${APP_NAME} account, you can safely ignore this email — no account
          is verified without this step.
        </p>
      </div>
    </div>
  </body>
</html>`;
}

/**
 * Builds and sends the verification email. Throws whatever the Resend client throws (a typed
 * `ResendError`) on failure; the caller catches it. Nothing sensitive is logged here.
 */
export async function sendVerificationEmail({
  to,
  token,
}: {
  to: string;
  token: string;
}): Promise<void> {
  const url = buildVerificationUrl(token);
  await sendEmail({
    to,
    subject: `Verify your email · ${APP_NAME}`,
    html: renderVerificationEmail(url),
  });
}
