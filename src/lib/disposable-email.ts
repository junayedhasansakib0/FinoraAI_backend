/**
 * Disposable / throwaway email protection (email-verification phase). A verification email sent to
 * a self-destructing inbox verifies nothing, so registration blocks the clearly-disposable domains
 * below. This is an ALLOW-by-default list: anything not explicitly listed passes, so Gmail, Outlook,
 * Yahoo, Proton, iCloud, university (`.edu`) and company domains all work untouched. The list is a
 * server-side secret of sorts — it is never sent to the client and the rejection message never
 * names it (R-A4-adjacent): the user simply sees "Please use a permanent email address."
 *
 * It is a maintained snapshot, not exhaustive; the goal is to stop the common throwaway providers,
 * not to win an arms race. New domains are added here as they surface.
 */

/** Lowercase, apex domains only. Subdomains are matched by suffix in `isDisposableEmail`. */
const DISPOSABLE_DOMAINS: ReadonlySet<string> = new Set([
  'mailinator.com',
  'guerrillamail.com',
  'guerrillamail.info',
  'guerrillamail.net',
  'guerrillamail.org',
  'grr.la',
  'sharklasers.com',
  '10minutemail.com',
  '10minutemail.net',
  '20minutemail.com',
  'tempmail.com',
  'temp-mail.org',
  'tempmailo.com',
  'throwawaymail.com',
  'getnada.com',
  'nada.email',
  'dispostable.com',
  'yopmail.com',
  'yopmail.net',
  'trashmail.com',
  'trashmail.net',
  'mailnesia.com',
  'maildrop.cc',
  'mintemail.com',
  'fakeinbox.com',
  'spam4.me',
  'mailcatch.com',
  'moakt.com',
  'emailondeck.com',
  'mohmal.com',
  'mailtemp.net',
  'tempmailaddress.com',
  'tmpmail.org',
  'tmpmail.net',
  'discard.email',
  'wegwerfmail.de',
  'einrot.com',
  'burnermail.io',
  'emailfake.com',
  'inboxbear.com',
  'tempinbox.com',
  'luxusmail.org',
]);

/**
 * True when the email's domain is a known disposable provider. Expects an already-trimmed,
 * lowercased address (the shape `User.email` is stored in); matches the exact domain and any
 * subdomain of a listed domain (e.g. `x.mailinator.com`).
 */
export function isDisposableEmail(email: string): boolean {
  const domain = email.slice(email.lastIndexOf('@') + 1);
  if (domain.length === 0) {
    return false;
  }

  if (DISPOSABLE_DOMAINS.has(domain)) {
    return true;
  }

  for (const blocked of DISPOSABLE_DOMAINS) {
    if (domain.endsWith(`.${blocked}`)) {
      return true;
    }
  }

  return false;
}
