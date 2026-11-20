// Summarizes a V8 .heapsnapshot by constructor, streaming the file so a snapshot larger than V8's string limit still parses.
// Run as a child of the process that wrote the snapshot: `node heap-snapshot-summary.mjs <file> [top]`; prints one JSON object.
// String contents are never printed: strings are only counted by type.
import { createReadStream } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

const [file, topArg] = process.argv.slice(2);
const TOP = Number(topArg) > 0 ? Number(topArg) : 30;
const CONSTRUCTOR_TYPES = new Set(['object', 'array', 'closure', 'native', 'regexp']);
const NODES = '"nodes":[', EDGES = '"edges":[', STRINGS = '"strings":[';
// Only known schema keys are emitted; arbitrary property names may contain user data.
const SAFE_PROPERTIES = new Set(['text', 'data', 'thinkingSignature', 'content', 'instructions', 'report', 'task', 'command', 'thinking', 'description', 'source', 'prompt']);

let phase = 'head', head = '', carry = '';
let fields = 0, typeAt = 0, nameAt = 1, sizeAt = 3, edgeCountAt = 4, typeNames = [];
let edgeFields, edgeTypeAt, edgeNameAt, edgeTargetAt, edgeTypes, nodeTypes, nodeSizes, nodeEdges;
let value = 0, inNumber = false, field = 0, type = 0, name = 0, size = 0, edgeCount = 0, nodes = 0, selfBytes = 0;
let owner = 0, ownerEdges = 0, edgeType = 0, edgeName = 0, edgeTarget = 0;
const groups = new Map(), byType = new Map(), retainerGroups = new Map();
let wanted, found, index = 0, raw = '', wantedHere = false, inString = false, escaped = false;

function startNodes(text) {
  const at = text.indexOf(NODES), snapshot = JSON.parse(`${text.slice(0, at).replace(/,\s*$/, '')}}`).snapshot, meta = snapshot.meta;
  fields = meta.node_fields.length; typeAt = meta.node_fields.indexOf('type'); nameAt = meta.node_fields.indexOf('name'); sizeAt = meta.node_fields.indexOf('self_size'); edgeCountAt = meta.node_fields.indexOf('edge_count');
  typeNames = meta.node_types[typeAt];
  edgeFields = meta.edge_fields.length; edgeTypeAt = meta.edge_fields.indexOf('type'); edgeNameAt = meta.edge_fields.indexOf('name_or_index'); edgeTargetAt = meta.edge_fields.indexOf('to_node'); edgeTypes = meta.edge_types[edgeTypeAt];
  nodeTypes = new Uint8Array(snapshot.node_count); nodeSizes = new Float64Array(snapshot.node_count); nodeEdges = new Uint32Array(snapshot.node_count);
  phase = 'nodes';
  return text.slice(at + NODES.length);
}
function node(size) {
  nodeTypes[nodes] = type; nodeSizes[nodes] = size; nodeEdges[nodes] = edgeCount;
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
      if (field === typeAt) type = value; else if (field === nameAt) name = value; else if (field === sizeAt) size = value; else if (field === edgeCountAt) edgeCount = value;
      if (++field === fields) { node(size); field = 0; }
      value = 0; inNumber = false;
    }
    if (code === 93) return text.slice(i + 1);
  }
}
function readEdges(text) {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 48 && code <= 57) { value = value * 10 + code - 48; inNumber = true; continue; }
    if (inNumber) {
      if (field === edgeTypeAt) edgeType = value; else if (field === edgeNameAt) edgeName = value; else if (field === edgeTargetAt) edgeTarget = value;
      if (++field === edgeFields) {
        while (owner < nodes && ownerEdges >= nodeEdges[owner]) { owner++; ownerEdges = 0; }
        const target = edgeTarget / fields, targetType = typeNames[nodeTypes[target]];
        if (owner < nodes && edgeTypes[edgeType] !== 'weak' && (targetType === 'string' || targetType === 'concatenated string' || targetType === 'sliced string')) {
          const kind = edgeTypes[edgeType], property = kind === 'property' ? edgeName : -1;
          const key = `${nodeTypes[owner]}:${kind}:${property}`;
          const group = retainerGroups.get(key) ?? { ownerType: typeNames[nodeTypes[owner]], kind, property, references: 0, referencedSelfBytes: 0 };
          group.references++; group.referencedSelfBytes += nodeSizes[target]; retainerGroups.set(key, group);
        }
        ownerEdges++; field = 0;
      }
      value = 0; inNumber = false;
    }
    if (code === 93) return text.slice(i + 1);
  }
}
function chosen() {
  const ranked = [...groups.values()].filter(g => g.selfBytes > 0).sort((a, b) => b.selfBytes - a.selfBytes).slice(0, TOP);
  wanted = new Set(ranked.map(g => g.name));
  for (const group of retainerGroups.values()) if (group.property >= 0) wanted.add(group.property);
  found = new Map();
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
    phase = 'findEdges'; text = rest;
  }
  if (phase === 'findEdges') {
    const joined = carry + text, at = joined.indexOf(EDGES);
    if (at < 0) { carry = joined.slice(-EDGES.length); continue; }
    carry = ''; phase = 'edges'; text = joined.slice(at + EDGES.length);
  }
  if (phase === 'edges') {
    const rest = readEdges(text);
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
const safeRetainers = new Map();
for (const g of retainerGroups.values()) {
  const property = found.get(g.property), edge = g.kind === 'property' ? (SAFE_PROPERTIES.has(property) ? property : '(other property)') : `(${g.kind})`;
  const key = `${g.ownerType}:${edge}`, prior = safeRetainers.get(key) ?? { ownerType: g.ownerType, edge, references: 0, referencedSelfBytes: 0 };
  prior.references += g.references; prior.referencedSelfBytes += g.referencedSelfBytes; safeRetainers.set(key, prior);
}
console.log(JSON.stringify({ nodes, selfBytes,
  byType: Object.fromEntries([...byType].sort(([, a], [, b]) => b.selfBytes - a.selfBytes)),
  topConstructors: ranked.map(g => ({ name: found.get(g.name) ?? `#${g.name}`, type: g.type, count: g.count, selfBytes: g.selfBytes })),
  // Non-weak incoming references can share a target; this is not retained size and must not be summed as unique bytes.
  stringRetainers: [...safeRetainers.values()].sort((a, b) => b.referencedSelfBytes - a.referencedSelfBytes).slice(0, TOP) }));
