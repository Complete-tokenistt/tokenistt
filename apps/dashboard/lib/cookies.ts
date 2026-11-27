/**
 * Whether the session cookie gets the `Secure` flag. Defaults to on in
 * production; set COOKIE_SECURE=false only when serving over plain HTTP on a
 * trusted network (browsers drop Secure cookies on non-localhost HTTP, which
 * makes login silently fail).
 */
export function sessionCookieSecure(): boolean {
  const override = process.env.COOKIE_SECURE;
  if (override === 'true') return true;
  if (override === 'false') return false;
  return process.env.NODE_ENV === 'production';
}
