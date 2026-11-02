/**
 * Secrets never reach the terminal or a log. `mask` is for showing "which credential" without
 * revealing it; `redactText` scrubs anything credential-shaped from free text (error messages,
 * verbose request logs).
 */

export function mask(secret: string | undefined): string {
  if (!secret) return '(none)';
  if (secret.length <= 8) return '****';
  const head = secret.startsWith('tktt_live_') ? 'tktt_live_' : secret.slice(0, 3);
  return `${head}…${secret.slice(-4)}`;
}

const PATTERNS: Array<[RegExp, string]> = [
  [/tktt_live_[A-Za-z0-9_]+/g, 'tktt_live_[REDACTED]'],
  [/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED]'],
  [/eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, '[REDACTED_JWT]'],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, 'sk-[REDACTED]'],
  [/(x-admin-secret["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1[REDACTED]'],
];

export function redactText(text: string): string {
  return PATTERNS.reduce((acc, [re, to]) => acc.replace(re, to), text);
}
