import { PASSWORD_MIN_LENGTH } from '../config/constants.js';

/**
 * Password policy shared by every server-side entry point that sets a password (registration and
 * change-password). Defining the rules once here keeps them from drifting (R-N5); the client keeps
 * its own mirror of these rules for the live strength meter, since `client/` and `server/` are
 * separate repositories and never import across the boundary (R-N7). The server is always the
 * authority — the frontend hints, the backend enforces (R-V1). Passwords are never logged (R-A4).
 */

/** One complexity rule: a human label (for the frontend checklist wording) and its test. */
interface PasswordRule {
  readonly label: string;
  readonly test: (password: string) => boolean;
}

/**
 * The four character-class requirements plus the length floor (ARCHITECTURE.md §6). Order matters
 * only for which unmet rule is reported first.
 */
export const PASSWORD_RULES: readonly PasswordRule[] = [
  { label: `at least ${String(PASSWORD_MIN_LENGTH)} characters`, test: (p) => p.length >= PASSWORD_MIN_LENGTH },
  { label: 'a lowercase letter', test: (p) => /[a-z]/.test(p) },
  { label: 'an uppercase letter', test: (p) => /[A-Z]/.test(p) },
  { label: 'a number', test: (p) => /\d/.test(p) },
  { label: 'a special character', test: (p) => /[^A-Za-z0-9]/.test(p) },
];

/** The unmet rules, in order. Empty means the password satisfies the whole policy. */
export function unmetPasswordRules(password: string): PasswordRule[] {
  return PASSWORD_RULES.filter((rule) => !rule.test(password));
}

/**
 * Rejects passwords that are just the email dressed up — the account's own address is the first
 * thing an attacker tries. Covers the identical case and the common "name + digits" derivations
 * (`john@example.com` → `john`, `john123`, `john123456`, `example123`) without being so aggressive
 * that a strong passphrase which merely contains a short fragment is blocked: it compares whole
 * normalised tokens for equality, never substrings.
 */
export function isPasswordDerivedFromEmail(email: string, password: string): boolean {
  const lowerPassword = password.toLowerCase();
  const [localRaw = '', domainRaw = ''] = email.toLowerCase().split('@');
  const domainBase = domainRaw.split('.')[0] ?? '';

  // The local part, the local part with its separators removed, each separated segment, and the
  // primary domain label. Fragments shorter than 3 chars are ignored so we do not block on, say,
  // a two-letter name segment appearing by coincidence.
  const tokens = new Set(
    [localRaw, localRaw.replace(/[._+-]/g, ''), domainBase, ...localRaw.split(/[._+-]/)].filter(
      (token) => token.length >= 3,
    ),
  );

  // The password reduced to its letters, then with any trailing digit run dropped — this turns
  // `john123`, `john123456` and `John1!` all back into `john` for comparison.
  const lettersOnly = lowerPassword.replace(/[^a-z]/g, '');

  for (const token of tokens) {
    const tokenLetters = token.replace(/[^a-z]/g, '');
    if (lowerPassword === token || lettersOnly === token || (tokenLetters.length >= 3 && lettersOnly === tokenLetters)) {
      return true;
    }
  }

  return false;
}
