export type OutputPreviewFormat = 'json' | 'diff' | 'search' | 'build/log';

export interface OutputPreview {
  text: string;
  format: OutputPreviewFormat;
  originalBytes: number;
  previewBytes: number;
  diagnosticMatches: number;
  omittedLines: number;
  omittedFields: number;
  useful: boolean;
}

const MAX_LINE_CHARS = 260;
const MAX_PREVIEW_LINES = 48;
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_JSON_NODES = 5000;
const MAX_JSON_DEPTH = 16;
const DIAGNOSTIC = /error|fail|exception|warning|panic|fatal|tests?:|passed|exit[\s_-]?code|stderr|stdout|\bstatus\s*[:=]?\s*(?:\d+|ok|failed|error)\b|\b(?:CS|TS|src|spc)\d{4}\b/i;
const EVIDENCE_TOKEN = /\b(?:error|fail(?:ed|ure)?|exception|warning|panic|fatal|tests?|passed|stderr|stdout|status|signal|exit[\s_-]?code)\b|(?:CS|TS|src|spc)\d{4}/gi;
const SEARCH_LINE = /^(?:[A-Za-z]:)?[^:\r\n]+:\d+(?::\d+)?:/;
const DIFF_MARKER = /^(?:diff --git |Index: |\*\*\* (?:Begin|End) Patch|@@\s)/;
const SEARCH_SUMMARY = /(?:\d+ matches?(?: in \d+ files?)?|found \d+ matches?|search completed)/i;
const JSON_KEY = /error|exception|fail|warn|stderr|stdout|exit.?code|status|diagnostic|test|message|\bcode\b/i;

const byteLength = (value: string) => Buffer.byteLength(value);
const safeSlice = (value: string, start: number, end: number) => {
  let result = value.slice(start, end);
  if (/[\ud800-\udbff]$/.test(result)) result = result.slice(0, -1);
  return result;
};

function clip(value: string, limit = MAX_LINE_CHARS) {
  if (value.length <= limit) return value;
  const evidence: string[] = [];
  EVIDENCE_TOKEN.lastIndex = 0;
  for (let match = EVIDENCE_TOKEN.exec(value); match && evidence.length < 2; match = EVIDENCE_TOKEN.exec(value)) {
    const from = Math.max(0, match.index - 28), to = Math.min(value.length, match.index + match[0].length + 48);
    const excerpt = `${from ? '…' : ''}${safeSlice(value, from, to)}${to < value.length ? '…' : ''}`;
    if (!evidence.includes(excerpt)) evidence.push(excerpt);
  }
  const parts = [safeSlice(value, 0, 54), ...evidence, safeSlice(value, Math.max(0, value.length - 54), value.length)];
  const joined = parts.join(' … ');
  return `${safeSlice(joined, 0, Math.max(1, limit - 16)).trimEnd()} … [line clipped]`;
}

function countDiagnostics(lines: readonly string[]) {
  let count = 0;
  for (const line of lines) if (DIAGNOSTIC.test(line)) count++;
  return count;
}

function addSome(target: Set<number>, source: readonly number[], limit: number, fromEnd = false) {
  const values = fromEnd ? source.slice(-limit) : source.slice(0, limit);
  for (const value of values) target.add(value);
}

function matchingLines(lines: readonly string[], matches: (line: string) => boolean) {
  const indexes: number[] = [];
  for (let index = 0; index < lines.length; index++) if (matches(lines[index])) indexes.push(index);
  return indexes;
}

function addEdges(target: Set<number>, length: number, head: number, tail: number) {
  for (let index = 0; index < Math.min(length, head); index++) target.add(index);
  for (let index = Math.max(0, length - tail); index < length; index++) target.add(index);
}

function selectedLines(lines: readonly string[], format: OutputPreviewFormat) {
  const chosen = new Set<number>();
  const diagnostics = matchingLines(lines, line => DIAGNOSTIC.test(line));
  if (format === 'diff') {
    const structure = matchingLines(lines, line => DIFF_MARKER.test(line) || /^(?:--- |\+\+\+ )/.test(line));
    const changes = matchingLines(lines, line => /^[+-]/.test(line) && !/^(?:\+\+\+ |--- )/.test(line));
    addSome(chosen, structure, 10); addSome(chosen, structure, 10, true);
    addSome(chosen, diagnostics, 10); addSome(chosen, diagnostics, 10, true);
    addSome(chosen, changes, 8); addSome(chosen, changes, 8, true);
    addEdges(chosen, lines.length, 3, 3);
  } else if (format === 'search') {
    const hits = matchingLines(lines, line => SEARCH_LINE.test(line) || SEARCH_SUMMARY.test(line));
    const summary = matchingLines(lines, line => SEARCH_SUMMARY.test(line));
    addSome(chosen, summary, 8);
    addSome(chosen, hits, 14); addSome(chosen, hits, 14, true);
    addSome(chosen, diagnostics, 8); addSome(chosen, diagnostics, 8, true);
    addEdges(chosen, lines.length, 2, 2);
  } else {
    addEdges(chosen, lines.length, 8, 12);
    addSome(chosen, diagnostics, 12); addSome(chosen, diagnostics, 12, true);
  }
  const all = [...chosen].sort((a, b) => a - b);
  if (all.length <= MAX_PREVIEW_LINES) return all;
  // Keep the source order and both ends when format-specific rules produce an unusually dense selection.
  const keep = new Set<number>();
  addSome(keep, diagnostics, 12); addSome(keep, diagnostics, 12, true);
  addSome(keep, all, MAX_PREVIEW_LINES - keep.size);
  return [...keep].sort((a, b) => a - b).slice(0, MAX_PREVIEW_LINES);
}

function jsonPath(parent: string, key: string | number) {
  return typeof key === 'number' || /^[A-Za-z_$][\w$]*$/.test(String(key))
    ? `${parent}.${key}` : `${parent}[${JSON.stringify(key)}]`;
}

function jsonEvidence(text: string): { lines: string[]; omittedFields: number } | undefined {
  if (byteLength(text) > MAX_JSON_BYTES) return undefined;
  let root: unknown;
  try { root = JSON.parse(text); } catch { return undefined; }

  const entries: { line: string; priority: number; order: number }[] = [];
  const stack: { value: unknown; path: string; key: string; depth: number }[] = [{ value: root, path: '$', key: '', depth: 0 }];
  let visited = 0, order = 0, omittedFields = 0;
  if (Array.isArray(root)) entries.push({ line: `JSON structure: array with ${root.length} entries`, priority: 2, order: order++ });
  else if (root && typeof root === 'object') {
    const keys = Object.keys(root);
    const shown = keys.slice(0, 16);
    entries.push({ line: `JSON structure: object with keys ${shown.join(', ')}${keys.length > shown.length ? `, … (+${keys.length - shown.length})` : ''}`, priority: 2, order: order++ });
  } else entries.push({ line: `JSON structure: ${typeof root}`, priority: 2, order: order++ });

  while (stack.length && visited < MAX_JSON_NODES) {
    const current = stack.pop()!; visited++;
    if (current.depth >= MAX_JSON_DEPTH) { omittedFields++; continue; }
    const value = current.value;
    if (Array.isArray(value)) {
      if (value.length > 200) omittedFields += value.length - 200;
      for (let index = Math.min(value.length, 200) - 1; index >= 0; index--) {
        stack.push({ value: value[index], path: jsonPath(current.path, index), key: String(index), depth: current.depth + 1 });
      }
      continue;
    }
    if (value && typeof value === 'object') {
      const keys = Object.keys(value);
      if (keys.length > 200) omittedFields += keys.length - 200;
      for (let index = Math.min(keys.length, 200) - 1; index >= 0; index--) {
        const key = keys[index];
        stack.push({ value: (value as Record<string, unknown>)[key], path: jsonPath(current.path, key), key, depth: current.depth + 1 });
      }
      continue;
    }
    if (!current.key) continue;
    const priority = JSON_KEY.test(current.key) ? 0 : current.depth <= 2 ? 1 : 3;
    if (priority < 3) {
      const rendered = typeof value === 'string' ? JSON.stringify(clip(value, 180)) : JSON.stringify(value);
      entries.push({ line: `${current.path} = ${rendered}`, priority, order: order++ });
    } else omittedFields++;
  }
  if (stack.length) omittedFields += stack.length;
  const evidence = entries.filter(entry => entry.priority < 3).sort((a, b) => a.priority - b.priority || a.order - b.order);
  const limited = evidence.slice(0, 28);
  omittedFields += Math.max(0, evidence.length - limited.length);
  return { lines: limited.map(entry => clip(entry.line)), omittedFields };
}

function detectFormat(lines: readonly string[], json?: ReturnType<typeof jsonEvidence>): OutputPreviewFormat {
  if (json) return 'json';
  const hasHunk = lines.some(line => /^@@\s/.test(line));
  const hasFileHeaders = lines.some(line => /^--- /.test(line)) && lines.some(line => /^\+\+\+ /.test(line));
  const hasDiff = lines.some(line => /^diff --git /.test(line))
    || hasHunk && (lines.some(line => /^Index: /.test(line)) || hasFileHeaders || lines.some(line => /^\*\*\* Begin Patch$/.test(line)));
  if (hasDiff) return 'diff';
  const nonempty = lines.filter(line => line.trim().length > 0);
  const searchHits = nonempty.filter(line => SEARCH_LINE.test(line)).length;
  const hasSummary = nonempty.some(line => SEARCH_SUMMARY.test(line));
  if (hasSummary || (nonempty.length >= 3 && searchHits >= Math.min(3, Math.ceil(nonempty.length * 0.7)))) return 'search';
  return 'build/log';
}

export function previewOutput(text: string): OutputPreview {
  const lines = text.split(/\r?\n/);
  const diagnostics = countDiagnostics(lines);
  const candidateJson = /^[\s]*[\[{]/.test(text);
  const json = candidateJson ? jsonEvidence(text) : undefined;
  const format = detectFormat(lines, json);
  const selected = format === 'json' ? [] : selectedLines(lines, format);
  const omittedLines = format === 'json' ? Math.max(0, lines.length - 1) : Math.max(0, lines.length - selected.length);
  const omittedFields = json?.omittedFields ?? 0;
  const metadata = `[Lossy preview: ${format}; ${lines.length} input lines; ${omittedLines} lines omitted; ${omittedFields} JSON fields omitted; ${diagnostics} diagnostic-pattern matches, not a verdict. Retrieve/search the original before relying on missing evidence.]`;
  const body = json
    ? json.lines
    : selected.map(index => `${index + 1}: ${clip(lines[index])}`);
  const result = `${metadata}\n${body.join('\n')}`;
  const useful = candidateJson ? json !== undefined : lines.length > 1 || diagnostics > 0;
  return {
    text: result,
    format,
    originalBytes: byteLength(text),
    previewBytes: byteLength(result),
    diagnosticMatches: diagnostics,
    omittedLines,
    omittedFields,
    useful,
  };
}
