/**
 * Email normalization (audit fix F1).
 *
 * Every write path that stores a User email must run it through
 * `normalizeEmail` so lookups (which are always lowercased) match. Storing a
 * verbatim email meant any account with an uppercase character could never
 * authenticate, because the login query lowercases the input first.
 */

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
