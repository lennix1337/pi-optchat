export type OutputPreviewFormat = 'json' | 'diff' | 'search' | 'html' | 'build/log';

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
const MAX_TABLE_ROWS = 40;
const MAX_TABLE_COLS = 8;
const DIAGNOSTIC = /error|fail|exception|warning|panic|fatal|tests?:|passed|exit[\s_-]?code|stderr|stdout|\bstatus\s*[:=]?\s*(?:\d+|ok|failed|error)\b|\b(?:CS|TS|src|spc)\d{4}\b/i;
const EVIDENCE_TOKEN = /\b(?:error|fail(?:ed|ure)?|exception|warning|panic|fatal|tests?|passed|stderr|stdout|status|signal|exit[\s_-]?code)\b|(?:CS|TS|src|spc)\d{4}/gi;
const SEARCH_LINE = /^(?:[A-Za-z]:)?[^:\r\n]+:\d+(?::\d+)?:/;
const SEARCH_HIT = /^((?:[A-Za-z]:)?[^:\r\n]+):(\d+(?::\d+)?):(.*)$/;
const DIFF_MARKER = /^(?:diff --git |Index: |\*\*\* (?:Begin|End) Patch|@@\s)/;
const LOCKFILE_PATH = /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|Gemfile\.lock|poetry\.lock|Pipfile\.lock|composer\.lock|go\.sum|flake\.lock|packages\.lock\.json|[^/]+\.lock)$/i;
// Only existence matters: matching the final digit avoids quadratic backtracking on long numeric lines.
const SEARCH_SUMMARY = /(?:\d matches?|search completed)/i;
const JSON_KEY = /error|exception|fail|warn|stderr|stdout|exit.?code|status|diagnostic|test|message|\bcode\b/i;
const TABLE_PRIORITY_KEY = /^(?:id|number|name|title|status|state|conclusion|error|message|exitCode|code|type|level|kind)$/i;
const TABLE_OUTLIER = /error|fail|failed|failure|conflict|conflicting|panic|fatal|exception|warn|timeout|denied|rejected/i;
const HTML_START = /^\s*(?:<!doctype\s+html\b|<html\b|<head\b|<body\b)/i;
const HTML_TAG = /<(?:div|p|span|table|tr|td|th|ul|ol|li|h[1-6]|script|style|nav|main|section|article|header|footer|form|a\s+href)\b/gi;
const HTML_ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&nbsp;': ' ' };

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

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function tableCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return clip(value.replace(/[\r\n\t|]+/g, ' ').trim(), 48);
  if (typeof value !== 'object') return String(value);
  if (Array.isArray(value)) return `[${value.length} items]`;
  const keys = Object.keys(value);
  if (keys.length <= 2) {
    const vals = keys.map(k => (value as Record<string, unknown>)[k]).filter(v => v === null || typeof v !== 'object');
    if (vals.length === keys.length) return clip(vals.map(String).join('/').replace(/[\r\n\t|]+/g, ' '), 48);
  }
  return `{${keys.length} keys}`;
}

function tabulateJsonArray(path: string, items: unknown[]): { lines: string[]; omittedFields: number } | undefined {
  if (items.length < 3) return undefined;
  const sampleLimit = Math.min(items.length, 50);
  let objectCount = 0;
  for (let i = 0; i < sampleLimit; i++) if (isPlainObject(items[i])) objectCount++;
  if (objectCount < Math.ceil(sampleLimit * 0.75)) return undefined;

  const keyCounts = new Map<string, number>();
  const scanLimit = Math.min(items.length, 200);
  for (let i = 0; i < scanLimit; i++) {
    const item = items[i];
    if (!isPlainObject(item)) continue;
    for (const key of Object.keys(item)) keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
  }
  if (!keyCounts.size) return undefined;

  const allKeys = [...keyCounts.keys()].sort((a, b) => {
    const pa = TABLE_PRIORITY_KEY.test(a) ? 0 : 1;
    const pb = TABLE_PRIORITY_KEY.test(b) ? 0 : 1;
    if (pa !== pb) return pa - pb;
    return (keyCounts.get(b) ?? 0) - (keyCounts.get(a) ?? 0);
  });
  const cols = allKeys.slice(0, MAX_TABLE_COLS);
  const extraCols = allKeys.length - cols.length;

  // Compute mode values for low-cardinality columns to detect non-majority outliers deterministically.
  const colModes = new Map<string, string>();
  for (const col of cols) {
    const freq = new Map<string, number>();
    for (let i = 0; i < scanLimit; i++) {
      const item = items[i];
      if (!isPlainObject(item)) continue;
      const cell = tableCell(item[col]);
      freq.set(cell, (freq.get(cell) ?? 0) + 1);
    }
    if (freq.size > 1 && freq.size <= 5) {
      let bestVal = '', bestCount = 0;
      for (const [val, count] of freq) if (count > bestCount) { bestVal = val; bestCount = count; }
      if (bestCount >= Math.ceil(scanLimit * 0.6)) colModes.set(col, bestVal);
    }
  }

  const formatRow = (index: number, tag = '') => {
    const item = items[index];
    if (!isPlainObject(item)) return `[${index}]${tag} ${tableCell(item)}`;
    return `[${index}]${tag} ${cols.map(c => tableCell(item[c])).join(' | ')}`;
  };

  const lines: string[] = [
    `JSON table ${path} (${items.length} rows, ${allKeys.length} cols${extraCols ? `, showing ${cols.length}` : ''}): ${cols.join(' | ')}`,
  ];

  let shownRows = 0;
  if (items.length <= MAX_TABLE_ROWS) {
    for (let i = 0; i < items.length; i++) lines.push(clip(formatRow(i)));
    shownRows = items.length;
  } else {
    const headCount = 10;
    const tailStart = items.length - 10;
    const outliers: number[] = [];
    for (let i = headCount; i < tailStart && outliers.length < 12; i++) {
      const item = items[i];
      if (!isPlainObject(item)) { outliers.push(i); continue; }
      const isDiag = cols.some(c => TABLE_OUTLIER.test(tableCell(item[c])));
      const isModeOutlier = !isDiag && [...colModes.entries()].some(([c, mode]) => tableCell(item[c]) !== mode);
      if (isDiag || isModeOutlier) outliers.push(i);
    }
    for (let i = 0; i < headCount; i++) lines.push(clip(formatRow(i)));
    const omittedMiddle = tailStart - headCount - outliers.length;
    if (omittedMiddle > 0) lines.push(`... (${omittedMiddle} rows omitted; ${outliers.length} outliers shown) ...`);
    for (const idx of outliers) lines.push(clip(formatRow(idx, '*')));
    for (let i = tailStart; i < items.length; i++) lines.push(clip(formatRow(i)));
    shownRows = headCount + outliers.length + 10;
  }

  const omittedRows = Math.max(0, items.length - shownRows);
  const avgKeys = Math.max(1, Math.round(allKeys.length));
  return { lines, omittedFields: omittedRows * avgKeys + extraCols * shownRows };
}

function jsonEvidence(text: string): { lines: string[]; omittedFields: number } | undefined {
  if (byteLength(text) > MAX_JSON_BYTES) return undefined;
  let root: unknown;
  try { root = JSON.parse(text); } catch { return undefined; }

  if (Array.isArray(root)) {
    const table = tabulateJsonArray('$', root);
    if (table) return table;
  }

  const entries: { line: string; priority: number; order: number }[] = [];
  const tables: string[] = [];
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
      if (tables.length < 2 && current.depth <= 2) {
        const table = tabulateJsonArray(current.path, value);
        if (table) {
          tables.push(...table.lines);
          omittedFields += table.omittedFields;
          continue;
        }
      }
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
  const scalarLimit = tables.length ? Math.max(8, MAX_PREVIEW_LINES - tables.length) : 28;
  const limited = evidence.slice(0, scalarLimit);
  omittedFields += Math.max(0, evidence.length - limited.length);
  const combined = [...limited.map(entry => clip(entry.line)), ...tables].slice(0, MAX_PREVIEW_LINES);
  return { lines: combined, omittedFields };
}

function collapseDiffLines(lines: readonly string[]): { body: string[]; omittedLines: number } {
  const sections: { start: number; end: number; file: string; lockfile: boolean }[] = [];
  let currentStart = 0;
  let currentFile = '';
  const flush = (end: number) => {
    if (end > currentStart) sections.push({ start: currentStart, end, file: currentFile, lockfile: LOCKFILE_PATH.test(currentFile) });
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      flush(i);
      currentStart = i;
      const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      currentFile = match ? match[2] : line.slice(11).trim();
    } else if (!currentFile && line.startsWith('+++ ')) {
      currentFile = line.slice(4).replace(/^b\//, '').trim();
    }
  }
  flush(lines.length);

  if (!sections.some(s => s.lockfile)) {
    const selected = selectedLines(lines, 'diff');
    return {
      body: selected.map(index => `${index + 1}: ${clip(lines[index])}`),
      omittedLines: Math.max(0, lines.length - selected.length),
    };
  }

  const body: string[] = [];
  let keptInputLines = 0;
  const nonLockLines: number[] = [];
  for (const section of sections) {
    if (section.lockfile) {
      let added = 0, removed = 0;
      for (let i = section.start; i < section.end; i++) {
        const line = lines[i];
        if (line.startsWith('+') && !line.startsWith('+++ ')) added++;
        else if (line.startsWith('-') && !line.startsWith('--- ')) removed++;
      }
      body.push(`${section.start + 1}: [lockfile collapsed: ${section.file} (+${added}/-${removed} lines)]`);
      keptInputLines += 1;
    } else {
      for (let i = section.start; i < section.end; i++) nonLockLines.push(i);
    }
  }
  const budget = Math.max(0, MAX_PREVIEW_LINES - body.length);
  if (nonLockLines.length && budget > 0) {
    const picked = new Set<number>();
    const diag = nonLockLines.filter(i => DIAGNOSTIC.test(lines[i]));
    const struct = nonLockLines.filter(i => DIFF_MARKER.test(lines[i]) || /^(?:--- |\+\+\+ )/.test(lines[i]));
    const changes = nonLockLines.filter(i => /^[+-]/.test(lines[i]) && !/^(?:\+\+\+ |--- )/.test(lines[i]));
    addSome(picked, diag, 12); addSome(picked, diag, 12, true);
    addSome(picked, struct, 12);
    addSome(picked, changes, 12);
    addSome(picked, nonLockLines, Math.min(4, budget));
    const ordered = [...picked].sort((a, b) => a - b).slice(0, budget);
    for (const index of ordered) body.push(`${index + 1}: ${clip(lines[index])}`);
    keptInputLines += ordered.length;
  }
  return { body, omittedLines: Math.max(0, lines.length - keptInputLines) };
}

function groupSearchLines(lines: readonly string[]): { body: string[]; omittedLines: number } {
  const byFile = new Map<string, { lineNum: string; content: string; isDiag: boolean }[]>();
  const summaries: { index: number; text: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const hit = SEARCH_HIT.exec(line);
    if (hit) {
      const [, file, lineNum, content] = hit;
      let list = byFile.get(file);
      if (!list) { list = []; byFile.set(file, list); }
      list.push({ lineNum, content, isDiag: DIAGNOSTIC.test(line) });
    } else if (SEARCH_SUMMARY.test(line) || DIAGNOSTIC.test(line)) {
      summaries.push({ index: i, text: line });
    }
  }
  if (!byFile.size) {
    const selected = selectedLines(lines, 'search');
    return {
      body: selected.map(index => `${index + 1}: ${clip(lines[index])}`),
      omittedLines: Math.max(0, lines.length - selected.length),
    };
  }

  const body: string[] = [];
  let shownHits = 0;
  const maxBodyForFiles = Math.max(4, MAX_PREVIEW_LINES - Math.min(4, summaries.length));
  const files = [...byFile.entries()].sort((a, b) => {
    const da = a[1].some(h => h.isDiag) ? 0 : 1;
    const db = b[1].some(h => h.isDiag) ? 0 : 1;
    return da - db;
  });

  const perFileCap = files.length <= 4 ? 8 : files.length <= 12 ? 3 : 2;
  for (const [file, hits] of files) {
    if (body.length + 2 > maxBodyForFiles) break;
    body.push(`${file} (${hits.length} ${hits.length === 1 ? 'match' : 'matches'}):`);
    const diags = hits.filter(h => h.isDiag);
    const chosen: typeof hits = [];
    for (const h of diags) if (chosen.length < perFileCap && !chosen.includes(h)) chosen.push(h);
    if (chosen.length < perFileCap && !chosen.includes(hits[0])) chosen.push(hits[0]);
    if (chosen.length < perFileCap && hits.length > 1 && !chosen.includes(hits[hits.length - 1])) chosen.push(hits[hits.length - 1]);
    for (const h of hits) {
      if (chosen.length >= perFileCap) break;
      if (!chosen.includes(h)) chosen.push(h);
    }
    for (const h of chosen) {
      if (body.length >= maxBodyForFiles) break;
      body.push(`  ${h.lineNum}: ${clip(h.content, MAX_LINE_CHARS - 12)}`);
      shownHits++;
    }
  }
  for (const s of summaries.slice(-4)) {
    if (body.length < MAX_PREVIEW_LINES) {
      body.push(`${s.index + 1}: ${clip(s.text)}`);
      shownHits++;
    }
  }
  return { body, omittedLines: Math.max(0, lines.length - shownHits) };
}

function isHtml(text: string): boolean {
  const head = text.slice(0, 512);
  if (HTML_START.test(head)) return true;
  const sample = text.slice(0, 4096);
  const matches = sample.match(HTML_TAG);
  return matches !== null && matches.length >= 3;
}

function decodeEntities(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|#39|apos|nbsp);|&#(\d+);|&#x([0-9a-fA-F]+);/g, (full, dec, hex) => {
    if (dec) { const cp = Number(dec); return cp >= 32 && cp <= 0x10ffff ? String.fromCodePoint(cp) : full; }
    if (hex) { const cp = Number.parseInt(hex, 16); return cp >= 32 && cp <= 0x10ffff ? String.fromCodePoint(cp) : full; }
    return HTML_ENTITIES[full] ?? full;
  });
}

function htmlPreview(text: string, originalLines: readonly string[]): { body: string[]; omittedLines: number; useful: boolean } {
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(text);
  const title = titleMatch ? decodeEntities(titleMatch[1]).replace(/\s+/g, ' ').trim() : '';
  const stripped = decodeEntities(
    text
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<(script|style|noscript|title)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
      .replace(/<\/?(?:p|div|li|tr|h[1-6]|section|article|header|footer|nav|main|blockquote|pre|br|hr)\b[^>]*>/gi, '\n')
      .replace(/<\/t[dh]>/gi, ' | ')
      .replace(/<[^>]+>/g, ' '),
  );
  const cleanLines = stripped
    .split(/\r?\n/)
    .map(line => line.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean);
  if (title) cleanLines.unshift(`Title: ${title}`);

  const chosen = cleanLines.length <= MAX_PREVIEW_LINES
    ? cleanLines.map((line, i) => `${i + 1}: ${clip(line)}`)
    : selectedLines(cleanLines, 'build/log').map(i => `${i + 1}: ${clip(cleanLines[i])}`);
  const joined = chosen.join('\n');
  const useful = chosen.length > 0 && (byteLength(joined) < byteLength(text) * 0.85 || originalLines.length > 1);
  return { body: chosen, omittedLines: Math.max(0, originalLines.length - chosen.length), useful };
}

function detectFormat(lines: readonly string[], text: string, json?: ReturnType<typeof jsonEvidence>): OutputPreviewFormat {
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
  if (isHtml(text)) return 'html';
  return 'build/log';
}

export function previewOutput(text: string): OutputPreview {
  const lines = text.split(/\r?\n/);
  const diagnostics = countDiagnostics(lines);
  const candidateJson = /^[\s]*[\[{]/.test(text);
  const json = candidateJson ? jsonEvidence(text) : undefined;
  const format = detectFormat(lines, text, json);

  let body: string[];
  let omittedLines: number;
  let useful: boolean;
  if (format === 'json' && json) {
    body = json.lines;
    omittedLines = Math.max(0, lines.length - 1);
    useful = true;
  } else if (format === 'diff') {
    const collapsed = collapseDiffLines(lines);
    body = collapsed.body;
    omittedLines = collapsed.omittedLines;
    useful = lines.length > 1 || diagnostics > 0;
  } else if (format === 'search') {
    const grouped = groupSearchLines(lines);
    body = grouped.body;
    omittedLines = grouped.omittedLines;
    useful = lines.length > 1 || diagnostics > 0;
  } else if (format === 'html') {
    const html = htmlPreview(text, lines);
    body = html.body;
    omittedLines = html.omittedLines;
    useful = html.useful;
  } else {
    const selected = selectedLines(lines, format);
    body = selected.map(index => `${index + 1}: ${clip(lines[index])}`);
    omittedLines = Math.max(0, lines.length - selected.length);
    useful = candidateJson ? false : lines.length > 1 || diagnostics > 0;
  }

  const omittedFields = json?.omittedFields ?? 0;
  const metadata = `[Lossy preview: ${format}; ${lines.length} input lines; ${omittedLines} lines omitted; ${omittedFields} JSON fields omitted; ${diagnostics} diagnostic-pattern matches, not a verdict. Retrieve/search the original before relying on missing evidence.]`;
  const result = `${metadata}\n${body.join('\n')}`;
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
