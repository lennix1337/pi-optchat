export const OUTPUT_QUERY_MAX_LINES = 200;
export const OUTPUT_QUERY_MAX_FIELDS = 50;
export const OUTPUT_QUERY_MAX_BYTES = 24_000;

export type OutputQuery =
  | { kind: 'lines'; startLine: number; endLine: number }
  | { kind: 'json'; path?: string; fields?: string[] };

type PathSegment = string | number;

const forbiddenKeys = new Set(['__proto__', 'prototype', 'constructor']);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function boundedResult(text: string, request: string) {
  if (Buffer.byteLength(text) > OUTPUT_QUERY_MAX_BYTES)
    throw new Error(`Output query exceeds ${OUTPUT_QUERY_MAX_BYTES}-byte limit; request ${request}, or page the original with output_read offset/limit without a query`);
  return text;
}

function lineRange(text: string, startLine: number, endLine: number) {
  if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) || startLine < 1 || endLine < startLine
    || endLine - startLine + 1 > OUTPUT_QUERY_MAX_LINES)
    throw new Error(`Invalid line range: use 1-based startLine <= endLine, at most ${OUTPUT_QUERY_MAX_LINES} lines per query`);
  const lines = text.split(/\r\n|\n|\r/);
  if (endLine > lines.length) throw new Error(`Line range exceeds output length (${lines.length} lines); use endLine ${lines.length} or less`);
  const selected = lines.slice(startLine - 1, endLine).map((line, index) => `${startLine + index}: ${line}`).join('\n');
  return boundedResult(`[Lines ${startLine}-${endLine} of ${lines.length}; 1-based inclusive]\n${selected}`, 'fewer or shorter lines');
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

/** The error for an index the value cannot serve, naming the indexes it can. */
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

function selectFields(value: unknown, fields: string[]) {
  if (!isRecord(value)) throw new Error('JSON fields can only be selected from an object');
  if (!Array.isArray(fields) || fields.length < 1 || fields.length > OUTPUT_QUERY_MAX_FIELDS)
    throw new Error(`Invalid JSON fields; select 1-${OUTPUT_QUERY_MAX_FIELDS} fields`);
  const selected: Record<string, unknown> = Object.create(null);
  const seen = new Set<string>();
  for (const field of fields) {
    if (typeof field !== 'string' || field.length < 1 || field.length > 200 || forbiddenKeys.has(field))
      throw new Error('Invalid JSON field name');
    if (seen.has(field)) throw new Error(`Duplicate JSON field "${field}"`);
    seen.add(field);
    if (!Object.hasOwn(value, field)) throw new Error(`JSON field "${field}" was not found`);
    selected[field] = value[field];
  }
  return selected;
}

function jsonQuery(text: string, path: string | undefined, fields: string[] | undefined) {
  let root: unknown;
  try { root = JSON.parse(text); }
  catch { throw new Error('Stored output is not valid JSON'); }
  const value = path === undefined ? root : resolvePath(root, parsePath(path));
  const result = fields === undefined ? value : selectFields(value, fields);
  const serialized = JSON.stringify(result);
  if (serialized === undefined) throw new Error('JSON query did not select a serializable value');
  return boundedResult(serialized, 'fewer fields');
}

/** Restricted structured projection over a stored original; no expression evaluation or arbitrary JSONPath. */
export function queryOutput(text: string, query: OutputQuery): string {
  if (!query || typeof query !== 'object') throw new Error('Invalid output query');
  if (query.kind === 'lines') return lineRange(text, query.startLine, query.endLine);
  if (query.kind === 'json') return jsonQuery(text, query.path, query.fields);
  throw new Error('Invalid output query kind');
}
