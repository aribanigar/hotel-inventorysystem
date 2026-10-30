/**
 * Money is always an integer in minor units (paise for INR). Floats are never used
 * for prices: 0.1 + 0.2 !== 0.3 is how a "price changed" false alarm is born.
 */

const DECIMAL = /^-?\d+(\.\d+)?$/;

/**
 * Converts a decimal amount from an external system ("12500.5", 12500.5) to minor
 * units exactly, by string manipulation rather than floating-point multiplication.
 * Returns null for anything that isn't a clean, positive, finite amount.
 */
export function decimalToMinor(value: unknown, exponent = 2): number | null {
  let s: string;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    // toFixed avoids exponent notation (1e21) and float tails; round half up at exponent+1.
    s = value.toFixed(exponent + 1);
  } else if (typeof value === 'string') {
    s = value.trim();
  } else {
    return null;
  }
  if (!DECIMAL.test(s) || s.startsWith('-')) return null;

  const [whole = '0', frac = ''] = s.split('.');
  const padded = (frac + '0'.repeat(exponent + 1)).slice(0, exponent + 1);
  let minor = BigInt(whole) * 10n ** BigInt(exponent) + BigInt(padded.slice(0, exponent) || '0');
  if (Number(padded[exponent] ?? '0') >= 5) minor += 1n; // round half up on the next digit

  if (minor <= 0n || minor > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(minor);
}

export function formatMinor(minor: number, currency = 'INR'): string {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency }).format(minor / 100);
}
