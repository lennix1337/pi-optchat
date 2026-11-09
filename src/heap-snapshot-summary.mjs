// Summarizes a V8 .heapsnapshot by constructor, streaming the file so a snapshot larger than V8's string limit still parses.
// Run as a child of the process that wrote the snapshot: `node heap-snapshot-summary.mjs <file> [top]`; prints one JSON object.
// String contents are never printed: strings are only counted by type.
import { createReadStream } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

const [file, topArg] = process.argv.slice(2);
const TOP = Number(topArg) > 0 ? Number(topArg) : 30;
const CONSTRUCTOR_TYPES = new Set(['object', 'array', 'closure', 'native', 'regexp']);
const NODES = '"nodes":[', STRINGS = '"strings":[';

let phase = 'head', head = '', carry = '';
let fields = 0, typeAt = 0, nameAt = 1, sizeAt = 3, typeNames = [];
let value = 0, inNumber = false, field = 0, type = 0, name = 0, size = 0, nodes = 0, selfBytes = 0;
const groups = new Map(), byType = new Map();
let wanted, found, index = 0, raw = '', wantedHere = false, inString = false, escaped = false;

function startNodes(text) {
  const at = text.indexOf(NODES), meta = JSON.parse(`${text.slice(0, at).replace(/,\s*$/, '')}}`).snapshot.meta;
  fields = meta.node_fields.length; typeAt = meta.node_fields.indexOf('type'); nameAt = meta.node_fields.indexOf('name'); sizeAt = meta.node_fields.indexOf('self_size');
  typeNames = Array.isArray(meta.node_types[0]) ? meta.node_types[0] : [];
  phase = 'nodes';
  return text.slice(at + NODES.length);
}
function node(size) {
  nodes++; selfBytes += size;
  const typeName = typeNames[type] ?? String(type);
  const bucket = byType.get(typeName) ?? { count: 0, selfBytes: 0 };
  bucket.count++; bucket.selfBytes += size; byType.set(typeName, bucket);
  if (!CONSTRUCTOR_TYPES.has(typeName)) return;
  const key = name * 16 + type, group = groups.get(key) ?? { type: typeName, name, count: 0, selfBytes: 0 };
  group.count++; group.selfBytes += size; groups.set(key, group);
}
/** Returns the text left after the nodes array, or undefined while it continues. */
function readNodes(text) {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 48 && code <= 57) { value = value * 10 + code - 48; inNumber = true; continue; }
    if (inNumber) {
      if (field === typeAt) type = value; else if (field === nameAt) name = value; else if (field === sizeAt) size = value;
      if (++field === fields) { node(size); field = 0; }
      value = 0; inNumber = false;
    }
    if (code === 93) return text.slice(i + 1);
  }
}
function chosen() {
  const ranked = [...groups.values()].filter(g => g.selfBytes > 0).sort((a, b) => b.selfBytes - a.selfBytes).slice(0, TOP);
  wanted = new Set(ranked.map(g => g.name)); found = new Map();
  return ranked;
}
function readStrings(text) {
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (wantedHere) raw += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') {
        inString = false;
        if (wantedHere) found.set(index, JSON.parse(raw)); // raw keeps both quotes
        index++;
      }
    } else if (char === '"') { inString = true; wantedHere = wanted.has(index); raw = wantedHere ? '"' : ''; }
    else if (char === ']') return true;
  }
  return false;
}

let ranked = [];
const decoder = new StringDecoder('utf8');
for await (const chunk of createReadStream(file, { highWaterMark: 4 * 1024 * 1024 })) {
  let text = decoder.write(chunk);
  if (phase === 'head') {
    head += text; const at = head.indexOf(NODES);
    if (at < 0) continue;
    text = startNodes(head); head = '';
  }
  if (phase === 'nodes') {
    const rest = readNodes(text);
    if (rest === undefined) continue;
    ranked = chosen(); phase = 'skip'; text = rest;
  }
  if (phase === 'skip') {
    // Edges are numbers only, so the strings marker cannot occur inside them; it may straddle two chunks.
    const joined = carry + text, at = joined.indexOf(STRINGS);
    if (at < 0) { carry = joined.slice(-STRINGS.length); continue; }
    phase = 'strings'; text = joined.slice(at + STRINGS.length);
  }
  if (phase === 'strings' && readStrings(text)) break;
}
if (phase !== 'strings') { console.error('not a V8 heap snapshot'); process.exit(2); }
console.log(JSON.stringify({ nodes, selfBytes,
  byType: Object.fromEntries([...byType].sort(([, a], [, b]) => b.selfBytes - a.selfBytes)),
  topConstructors: ranked.map(g => ({ name: found.get(g.name) ?? `#${g.name}`, type: g.type, count: g.count, selfBytes: g.selfBytes })) }));
