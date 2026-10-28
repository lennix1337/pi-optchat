/** An optional integer option within [min, max]; anything else is `invalid_options`. */
export function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  const n = value ?? fallback;
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error('invalid_options');
  return n;
}
