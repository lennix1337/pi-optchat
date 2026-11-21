export const OUTPUT_QUERY_MAX_LINES = 200;
export const OUTPUT_QUERY_MAX_FIELDS = 50;
export const OUTPUT_QUERY_MAX_BYTES = 24_000;
export const OUTPUT_QUERY_MAX_MATCHES = 50;
export const OUTPUT_QUERY_MAX_CONTEXT = 10;

export type JsonFilter = {
  field: string;
  equals?: string | number | boolean | null;
  contains?: string;
};

export type OutputQuery =
  | { kind: 'lines'; startLine: number; endLine: number }
  | { kind: 'json'; path?: string; fields?: string[]; filter?: JsonFilter }
  | { kind: 'grep'; pattern: string; ignoreCase?: boolean; context?: number }
  | { kind: 'outline'; maxDepth?: number };

type PathSegment = string | number;

const forbiddenKeys = new Set(['__proto__', 'prototype', 'constructor']);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function boundedResult(text: string, request: string) {
  if (Buffer.byteLength(text) > OUTPUT_QUERY_MAX_BYTES)
    throw new Error(`Output query exceeds ${OUTPUT_QUERY_MAX_BYTES}-byte limit; request ${request}, or page the original with output_read offset/limit without a query`);
  return text;
}

function lineRange(text: string, startLine: number, requestedEnd: number) {
  if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(requestedEnd) || startLine < 1 || requestedEnd < startLine)
    throw new Error(`Invalid line range: use 1-based startLine <= endLine, at most ${OUTPUT_QUERY_MAX_LINES} lines per query`);

  let endLine = Math.min(requestedEnd, startLine + OUTPUT_QUERY_MAX_LINES - 1);

  const breaks = /\r\n|\n|\r/g;
  let count = 1, from = 0, to = text.length;
  while (breaks.test(text)) {
    if (count === endLine) {
      to = breaks.lastIndex - 1;
      if (text[to] === '\n' && text[to - 1] === '\r') to--;
    }
    count++;
    if (count === startLine) from = breaks.lastIndex;
  }
  if (startLine > count) throw new Error(`Line range exceeds output length (${count} lines); use endLine ${count} or less`);
  if (endLine > count) endLine = count;
  const selected = text.slice(from, to).split(/\r\n|\n|\r/).map((line, index) => `${startLine + index}: ${line}`).join('\n');
  return boundedResult(`[Lines ${startLine}-${endLine} of ${count}; 1-based inclusive]\n${selected}`, 'fewer or shorter lines');
}

function invalidPath(): never {
  throw new Error('Invalid JSON path; use $ followed by .property, [index], or ["quoted key"] segments');
}

function propertySegment(path: string, start: number) {
  const match = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(path.slice(start + 1));
  if (!match) return invalidPath();
  return { segment: match[0], next: start + match[0].length + 1 };
}

function bracketSegment(path: string, start: number) {
  const index = /^\[(0|[1-9]\d*)\]/.exec(path.slice(start));
  if (index) {
    const segment = Number(index[1]);
    if (!Number.isSafeInteger(segment)) return invalidPath();
    return { segment, next: start + index[0].length };
  }
  if (path[start + 1] !== '"') return invalidPath();
  let end = start + 2, escaped = false;
  for (; end < path.length; end++) {
    const char = path[end];
    if (escaped) escaped = false;
    else if (char === '\\') escaped = true;
    else if (char === '"') break;
  }
  if (end >= path.length || path[end + 1] !== ']') return invalidPath();
  let segment: unknown;
  try { segment = JSON.parse(path.slice(start + 1, end + 1)); }
  catch { return invalidPath(); }
  if (typeof segment !== 'string') return invalidPath();
  return { segment, next: end + 2 };
}

function parsePath(path: string): PathSegment[] {
  if (typeof path !== 'string' || !path.length || path.length > 1024 || path[0] !== '$') return invalidPath();
  const segments: PathSegment[] = [];
  let i = 1;
  while (i < path.length) {
    const parsed = path[i] === '.' ? propertySegment(path, i)
      : path[i] === '[' ? bracketSegment(path, i)
        : invalidPath();
    if (typeof parsed.segment === 'string' && forbiddenKeys.has(parsed.segment))
      throw new Error(`JSON path cannot traverse protected property "${parsed.segment}"`);
    segments.push(parsed.segment);
    i = parsed.next;
  }
  return segments;
}


function missingIndex(value: unknown, index: number) {
  const missing = `JSON path index ${index} does not exist; `;
  if (!Array.isArray(value)) return new Error(`${missing}the value is not an array`);
  if (!value.length) return new Error(`${missing}the array is empty`);
  return new Error(`${missing}the array has ${value.length} ${value.length === 1 ? 'item' : 'items'} (indexes 0-${value.length - 1})`);
}

function resolvePath(root: unknown, segments: PathSegment[]) {
  let value = root;
  for (const segment of segments) {
    if (typeof segment === 'number') {
      if (!Array.isArray(value) || segment >= value.length || !Object.hasOwn(value, segment)) throw missingIndex(value, segment);
      value = value[segment];
    } else {
      if (!isRecord(value)) throw new Error(`JSON path property "${segment}" requires an object`);
      if (!Object.hasOwn(value, segment)) throw new Error(`JSON path property "${segment}" was not found`);
      value = value[segment];
    }
  }
  return value;
}

function validateFields(fields: string[]) {
  if (!Array.isArray(fields) || fields.length < 1 || fields.length > OUTPUT_QUERY_MAX_FIELDS)
    throw new Error(`Invalid JSON fields; select 1-${OUTPUT_QUERY_MAX_FIELDS} fields`);
  const seen = new Set<string>();
  for (const field of fields) {
    if (typeof field !== 'string' || field.length < 1 || field.length > 200 || forbiddenKeys.has(field))
      throw new Error('Invalid JSON field name');
    if (seen.has(field)) throw new Error(`Duplicate JSON field "${field}"`);
    seen.add(field);
  }
}

function selectFields(value: unknown, fields: string[], strict = true) {
  if (!isRecord(value)) throw new Error('JSON fields can only be selected from an object');
  validateFields(fields);
  const selected: Record<string, unknown> = Object.create(null);
  for (const field of fields) {
    if (!Object.hasOwn(value, field)) {
      if (strict) throw new Error(`JSON field "${field}" was not found`);
      continue;
    }
    selected[field] = value[field];
  }
  return selected;
}

function filterJsonArray(value: unknown, filter: JsonFilter): unknown[] {
  if (!Array.isArray(value)) throw new Error('JSON filter requires an array');
  if (!filter || typeof filter !== 'object' || typeof filter.field !== 'string'
    || !filter.field.length || filter.field.length > 200 || forbiddenKeys.has(filter.field))
    throw new Error('Invalid JSON filter field');
  if (filter.equals === undefined && filter.contains === undefined)
    throw new Error('JSON filter requires equals or contains');
  const needle = filter.contains !== undefined ? filter.contains.toLowerCase() : undefined;
  return value.filter(item => {
    if (!isRecord(item) || !Object.hasOwn(item, filter.field)) return false;
    const actual = item[filter.field];
    if (filter.equals !== undefined && actual !== filter.equals) return false;
    if (needle !== undefined && !String(actual ?? '').toLowerCase().includes(needle)) return false;
    return true;
  });
}

function jsonQuery(text: string, query: Extract<OutputQuery, { kind: 'json' }>) {
  let root: unknown;
  try { root = JSON.parse(text); }
  catch { throw new Error('Stored output is not valid JSON'); }
  let value = query.path === undefined ? root : resolvePath(root, parsePath(query.path));
  if (query.filter !== undefined) value = filterJsonArray(value, query.filter);
  const result = query.fields === undefined
    ? value
    : Array.isArray(value)
      ? value.map(item => selectFields(item, query.fields!, false))
      : selectFields(value, query.fields, true);
  const serialized = JSON.stringify(result);
  if (serialized === undefined) throw new Error('JSON query did not select a serializable value');
  return boundedResult(serialized, 'fewer fields');
}

function grepQuery(text: string, query: Extract<OutputQuery, { kind: 'grep' }>) {
  if (typeof query.pattern !== 'string' || !query.pattern.length || query.pattern.length > 500)
    throw new Error('Invalid grep pattern: provide 1-500 characters');
  const context = query.context ?? 2;
  if (!Number.isSafeInteger(context) || context < 0 || context > OUTPUT_QUERY_MAX_CONTEXT)
    throw new Error(`Invalid grep context: use 0-${OUTPUT_QUERY_MAX_CONTEXT}`);
  let regex: RegExp;
  try { regex = new RegExp(query.pattern, query.ignoreCase ? 'i' : ''); }
  catch (error) { throw new Error(`Invalid grep pattern: ${error instanceof Error ? error.message : String(error)}`); }

  const lines = text.split(/\r\n|\n|\r/);
  const matched: number[] = [];
  let totalMatches = 0;
  for (let i = 0; i < lines.length; i++) {
    if (regex.test(lines[i])) {
      totalMatches++;
      if (matched.length < OUTPUT_QUERY_MAX_MATCHES) matched.push(i);
    }
  }
  const flags = query.ignoreCase ? 'i' : '';
  if (!matched.length) return `[Grep /${query.pattern}/${flags}: 0 matches in ${lines.length} lines]`;

  const ranges: [number, number][] = [];
  for (const idx of matched) {
    const start = Math.max(0, idx - context);
    const end = Math.min(lines.length - 1, idx + context);
    const prev = ranges[ranges.length - 1];
    if (prev && start <= prev[1] + 1) prev[1] = Math.max(prev[1], end);
    else ranges.push([start, end]);
  }
  const hunks = ranges.map(([start, end]) => {
    const out: string[] = [];
    for (let i = start; i <= end; i++) out.push(`${i + 1}: ${lines[i]}`);
    return out.join('\n');
  });
  const shown = totalMatches > matched.length ? ` (showing first ${matched.length})` : '';
  const header = `[Grep /${query.pattern}/${flags}: ${totalMatches} ${totalMatches === 1 ? 'match' : 'matches'}${shown} in ${lines.length} lines]`;
  return boundedResult(`${header}\n${hunks.join('\n--\n')}`, 'a narrower pattern or smaller context');
}

function describeJson(value: unknown, depth: number, maxDepth: number): string {
  if (value === null) return 'null';
  if (typeof value !== 'object') return typeof value;
  if (Array.isArray(value)) {
    if (!value.length) return 'Array(0)';
    if (depth >= maxDepth) return `Array(${value.length})`;
    return `Array(${value.length})<${describeJson(value[0], depth + 1, maxDepth)}>`;
  }
  const keys = Object.keys(value);
  if (depth >= maxDepth) return `Object(${keys.length} keys)`;
  const shown = keys.slice(0, 12).map(k => `${k}: ${describeJson((value as Record<string, unknown>)[k], depth + 1, maxDepth)}`);
  const rest = keys.length > 12 ? `, ... (+${keys.length - 12} keys)` : '';
  return `{ ${shown.join(', ')}${rest} }`;
}

function outlineQuery(text: string, maxDepth = 3) {
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 1 || maxDepth > 6)
    throw new Error('Invalid outline maxDepth: use 1-6');
  const bytes = Buffer.byteLength(text);
  if (/^\s*[\[{]/.test(text)) {
    try {
      const root: unknown = JSON.parse(text);
      return boundedResult(`[Outline: json; ${bytes} bytes]\n${describeJson(root, 0, maxDepth)}`, 'a smaller maxDepth');
    } catch {   }
  }
  const lines = text.split(/\r\n|\n|\r/);
  if (lines.some(l => l.startsWith('diff --git '))) {
    const files: string[] = [];
    let current = '', added = 0, removed = 0, hunks = 0, startLine = 1;
    const flush = () => { if (current) files.push(`L${startLine}: ${current} (+${added}/-${removed}, ${hunks} hunks)`); };
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (l.startsWith('diff --git ')) {
        flush();
        current = l.slice(11).trim();
        added = 0; removed = 0; hunks = 0; startLine = i + 1;
      } else if (l.startsWith('@@ ')) hunks++;
      else if (l.startsWith('+') && !l.startsWith('+++ ')) added++;
      else if (l.startsWith('-') && !l.startsWith('--- ')) removed++;
    }
    flush();
    return boundedResult(`[Outline: diff; ${lines.length} lines; ${bytes} bytes; ${files.length} files]\n${files.slice(0, 80).join('\n')}`, 'a narrower line range');
  }
  const landmark = /^(?:#{1,4}\s|===|---|\*\*|> |\[|Test|PASS|FAIL|error|warning|exit code)/i;
  const landmarks: string[] = [];
  let diagCount = 0;
  for (let i = 0; i < lines.length; i++) {
    if (/error|fail|warning|panic|fatal/i.test(lines[i])) diagCount++;
    if (landmarks.length < 40 && (i === 0 || i === lines.length - 1 || landmark.test(lines[i])))
      landmarks.push(`${i + 1}: ${lines[i].slice(0, 140)}`);
  }
  return boundedResult(`[Outline: text; ${lines.length} lines; ${bytes} bytes; ${diagCount} diagnostic lines]\n${landmarks.join('\n')}`, 'a narrower line range');
}

/** Restricted structured projection over a stored original; no expression evaluation or arbitrary JSONPath. */
export function queryOutput(text: string, query: OutputQuery): string {
  if (!query || typeof query !== 'object') throw new Error('Invalid output query');
  if (query.kind === 'lines') return lineRange(text, query.startLine, query.endLine);
  if (query.kind === 'json') return jsonQuery(text, query);
  if (query.kind === 'grep') return grepQuery(text, query);
  if (query.kind === 'outline') return outlineQuery(text, query.maxDepth);
  throw new Error('Invalid output query kind');
}
