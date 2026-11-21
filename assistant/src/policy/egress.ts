export type EgressReason = 'known_secret' | 'invalid_secret_config' | 'invalid_utf8' | 'oversize' | 'payment_data' | 'authentication_data' | 'sensitive_identifier';

const maxBytes = 1024 * 1024;

function validCard(candidate: string): boolean {
  const digits = candidate.replace(/[ -]/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  for (let i = digits.length - 1; i >= 0; i--) {
    let digit = Number(digits[i]);
    if ((digits.length - 1 - i) % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

// Heuristics are neither semantic PII detection nor authorization: they can miss
// sensitive content and flag benign content. The caller must enforce the result.
export function inspectEgress(bytes: Uint8Array, knownSecrets: readonly string[]): { decision: 'allow' | 'review' | 'deny'; reasons: EgressReason[] } {
  const reasons: EgressReason[] = [];
  const raw = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (knownSecrets.some(secret => secret.length > 0 && raw.includes(secret))) reasons.push('known_secret');
  if (knownSecrets.some(secret => secret.length === 0)) reasons.push('invalid_secret_config');
  if (bytes.byteLength > maxBytes) reasons.push('oversize');
  else {
    let text: string | undefined;
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      reasons.push('invalid_utf8');
    }
    if (text !== undefined) {
      const candidates = text.match(/(?<!\d)\d(?:[ -]?\d){12,18}(?!\d)/g) ?? [];
      if (candidates.some(validCard)) reasons.push('payment_data');
      if (/\b(?:api[_-]?key|access[_-]?token|auth(?:entication|orization)?|bearer|password|passwd|secret|token)\b\s*[:=]\s*["']?[^\s"',;}{]{4,}/i.test(text)) reasons.push('authentication_data');
      if (/\b(?:ssn|social security(?: number)?|tax id|passport(?: number)?)\s*[:=#-]\s*[a-z0-9][a-z0-9 -]{3,}/i.test(text) || /\b\d{3}-\d{2}-\d{4}\b/.test(text)) reasons.push('sensitive_identifier');
    }
  }
  return { decision: reasons.includes('known_secret') ? 'deny' : reasons.length ? 'review' : 'allow', reasons };
}
