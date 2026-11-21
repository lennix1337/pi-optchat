





const PRIVATE_KEY_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
const URL_AUTH_RE = /(https?:\/\/)([^:@\s/]+):([^@\s/]+)@/gi;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const SLACK_RE = /\b(?:xox[bpars]-[0-9A-Za-z-]{10,}|xapp-\d-[A-Za-z0-9-]{10,})\b/g;
const GITHUB_RE = /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g;
const SENTRY_RE = /\bsntry[su]_[A-Za-z0-9+/=_-]{20,}/g;
const AWS_RE = /\b(?:AKIA|ASIA|AROA|AIDA)[0-9A-Z]{16}\b/g;
const GOOGLE_API_RE = /\bAIza[0-9A-Za-z_-]{35,}\b/g;
const SK_KEY_RE = /\b(?:sk-(?:proj-|svcacct-|admin-|ant-api\d+-)?[A-Za-z0-9_-]{20,}|(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,})\b/g;
const BEARER_RE = /(\bBearer[ \t]+)([A-Za-z0-9._~+/=-]{16,})/gi;
const BASIC_RE = /(\bBasic[ \t]+)([A-Za-z0-9+/=]{16,})/g;
const ENV_LINE_RE = /^([ \t]*(?:(?:\d+[:|]|[-*])[ \t]*)?(?:export[ \t]+)?)([A-Z][A-Z0-9_]{2,})([ \t]*=[ \t]*)(.+)$/gm;
const KV_SECRET_RE = /([?&"']?(?:api[-_]?key|apikey|access[-_]?token|refresh[-_]?token|client[-_]?secret|auth[-_]?token|secret[-_]?key|x-api-key)["']?[ \t]*[:=][ \t]*["']?)([A-Za-z0-9._~+/=-]{12,})(["']?)/gi;

const SENSITIVE_ENV_KEY_RE = /(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|APIKEY|AUTH_KEY|PRIVATE_KEY|ACCESS_KEY|SIGNING_KEY|ENCRYPTION_KEY|CREDENTIAL)/;
const NON_SECRET_ENV_SUFFIX_RE = /(?:_PATH|_FILE|_DIR|_COUNT|_LIMIT|_TIMEOUT|_MS|_SECONDS|_ENABLED|_DISABLED|_MODE|_NAME|_TYPE|_HEADER|_PREFIX|_LENGTH|_MIN|_MAX|_TOKENS|_URL|_URI|_HOST|_PORT|_USER)$/;
const IGNORED_ENV_KEYS = new Set(['PWD', 'OLDPWD', 'PUBLIC_KEY']);
const PLACEHOLDER_VALUE_RE = /^(?:true|false|null|undefined|none|changeme|example|redacted|\[segredo:[^\]]+\])$/i;
const PURE_HEX_RE = /^[0-9a-fA-F]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const URL_SPAN_RE = /https?:\/\/[^\s"'<>]+/gi;
const PATH_SPAN_RE = /(?:[A-Za-z]:\\[^\s"'<>]+|(?:^|[\s"'(=:])\/(?:[\w.@+-]+\/)+[\w.@+-]*)/gm;
const ENTROPY_TOKEN_RE = /[A-Za-z0-9_+/-]{24,}=*/g;
const FILE_EXT_RE = /^\.(?:ts|tsx|js|jsx|mjs|cjs|json|jsonl|md|txt|log|css|html|map|png|jpg|jpeg|gif|webp|svg|rs|py|go|yml|yaml|toml|lock)\b/i;

export function shannonEntropy(value: string): number {
  if (!value.length) return 0;
  const counts = new Map<number, number>();
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function isLikelySkKey(token: string): boolean {
  if (/^(?:sk-(?:proj|svcacct|admin|ant-api\d+)-|(?:sk|rk)_(?:live|test)_)/.test(token)) return true;
  const body = token.slice(3);
  return /\d/.test(body) || (/[a-z]/.test(body) && /[A-Z]/.test(body));
}

function isPlaceholderOrPath(raw: string): boolean {
  const trimmed = raw.trim().replace(/^(['"])(.*)\1$/, '$2').trim();
  if (!trimmed || trimmed.length < 4 || /^\d+$/.test(trimmed)) return true;
  if (PLACEHOLDER_VALUE_RE.test(trimmed)) return true;
  if (trimmed.startsWith('$') || trimmed.startsWith('<') && trimmed.endsWith('>')) return true;
  if (trimmed.startsWith('/') || trimmed.startsWith('./') || trimmed.startsWith('../') || trimmed.startsWith('~/') || /^[A-Za-z]:\\/.test(trimmed)) return true;
  if (/^https?:\/\//i.test(trimmed) && !/^https?:\/\/[^:@\s/]+:[^@\s/]+@/i.test(trimmed)) return true;
  return false;
}

function collectSpans(text: string, regex: RegExp, spans: Array<[number, number]>) {
  regex.lastIndex = 0;
  for (let match: RegExpExecArray | null; (match = regex.exec(text)) !== null;) {
    spans.push([match.index, match.index + match[0].length]);
  }
}

function insideAnySpan(start: number, end: number, spans: readonly [number, number][]): boolean {
  for (const [s, e] of spans) {
    if (start >= s && end <= e) return true;
  }
  return false;
}

function isHighEntropySecret(token: string): boolean {

  if (token.length < 32 || token.length > 512 || /[/_-]/.test(token)) return false;
  if (PURE_HEX_RE.test(token) || UUID_RE.test(token) || /^(?:[A-Z][a-z]{2,}|\d+)+$/.test(token)) return false;
  const hasLower = /[a-z]/.test(token);
  const hasUpper = /[A-Z]/.test(token);
  const hasDigit = /\d/.test(token);
  if (!hasDigit || !(hasLower || hasUpper)) return false;

  const classes = (hasLower ? 1 : 0) + (hasUpper ? 1 : 0) + (hasDigit ? 1 : 0);
  if (classes < 3 && token.length < 32) return false;
  const threshold = classes >= 3 ? 3.8 : 4.1;
  return shannonEntropy(token) >= threshold;
}

function scrubEntropy(text: string): string {
  const excluded: Array<[number, number]> = [];
  if (text.includes('://')) collectSpans(text, URL_SPAN_RE, excluded);
  if (text.includes('/') || text.includes('\\')) collectSpans(text, PATH_SPAN_RE, excluded);

  return text.replace(ENTROPY_TOKEN_RE, (token, offset: number) => {
    const end = offset + token.length;
    const prev = offset > 0 ? text[offset - 1] : '';
    const next = end < text.length ? text[end] : '';
    if (prev === '/' || prev === '\\' || prev === '.' || prev === '@') return token;
    if (next === '/' || next === '\\') return token;
    if (next === '.' && FILE_EXT_RE.test(text.slice(end, end + 12))) return token;
    if (excluded.length && insideAnySpan(offset, end, excluded)) return token;
    return isHighEntropySecret(token) ? '[segredo:entropy]' : token;
  });
}

/** Scrubs secrets from `text`, replacing each match with `[segredo:<tipo>]`. */
export function scrubSecrets(text: string): string {
  if (!text) return text;
  let out = text;
  if (out.includes('-----BEGIN')) out = out.replace(PRIVATE_KEY_RE, '[segredo:private_key]');
  if (out.includes('://')) out = out.replace(URL_AUTH_RE, (_m, proto: string, _u: string, pass: string) =>
    pass.startsWith('[segredo:') ? _m : `${proto}[segredo:url_auth]@`);
  if (out.includes('eyJ')) out = out.replace(JWT_RE, '[segredo:jwt]');
  if (out.includes('xox') || out.includes('xapp-')) out = out.replace(SLACK_RE, '[segredo:slack]');
  if (out.includes('gh') || out.includes('github_pat_')) out = out.replace(GITHUB_RE, '[segredo:github]');
  if (out.includes('sntry')) out = out.replace(SENTRY_RE, '[segredo:api_key]');
  if (out.includes('AKIA') || out.includes('ASIA') || out.includes('AROA') || out.includes('AIDA')) out = out.replace(AWS_RE, '[segredo:aws]');
  if (out.includes('AIza')) out = out.replace(GOOGLE_API_RE, '[segredo:api_key]');
  if (out.includes('sk-') || out.includes('sk_') || out.includes('rk_')) {
    out = out.replace(SK_KEY_RE, token => isLikelySkKey(token) ? '[segredo:api_key]' : token);
  }
  if (/bearer/i.test(out)) {
    out = out.replace(BEARER_RE, (full, prefix: string, token: string) =>
      token.startsWith('[segredo:') ? full : `${prefix}[segredo:bearer]`);
  }
  if (out.includes('Basic')) {
    out = out.replace(BASIC_RE, (full, prefix: string, token: string) =>
      /\d|[+/=]/.test(token) ? `${prefix}[segredo:bearer]` : full);
  }
  if (out.includes('=')) {
    out = out.replace(ENV_LINE_RE, (full, prefix: string, key: string, eq: string, rawVal: string) => {
      if (IGNORED_ENV_KEYS.has(key) || NON_SECRET_ENV_SUFFIX_RE.test(key) || !SENSITIVE_ENV_KEY_RE.test(key)) return full;
      const val = rawVal.replace(/[ \t]+#.*$/, '').trim();
      if (isPlaceholderOrPath(val)) return full;
      return `${prefix}${key}${eq}[segredo:env]`;
    });
  }
  out = out.replace(KV_SECRET_RE, (full, prefix: string, val: string, suffix: string) => {
    if (val.startsWith('[segredo:') || UUID_RE.test(val) || PLACEHOLDER_VALUE_RE.test(val)) return full;
    return `${prefix}[segredo:api_key]${suffix}`;
  });
  return scrubEntropy(out);
}
