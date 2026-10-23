// Stages (--stage): "standing" (default) samples leaves and merges where the standing-constraint boilerplate really is (index >= 43500) and
// applies the decision rule recorded in PREREGISTERED before any request; "pairs" samples tool call + result pairs across the two days.
// The first "pairs" run also measured V2 (call and result in one line, result line a stub); V2 was rejected (it lost 30 points of the call's
// facts) and removed from src, so only its recorded results remain (summary-ab-<date>-pairs.json).
// Explicit opt-in A/B of OptChat's summary prompts with REAL compactor requests (not part of `npm test`).
// Set OPTCHAT_AB_PROFILE to an explicitly selected profile; use --dry first. Live execution also requires --allow-provider-calls.
// It samples messages and summary lines from a real profile (read-only), builds each compactor request through the variant's own
// createCompressor, and scores bytes, latency and fact recall. `--dry` prints the sample and the planned requests and sends nothing.
//   V0  prompts at the baseline commit (extracted with `git archive` into scratchpad/benchmarks/baseline-<commit>)
//   V1  the working tree's prompts (or --v1-dir <dir containing src>): leaf delta, merge once, a call names its action only (call and result keep separate lines)
//   V2  (recorded only, no longer runnable) V1 plus pairing: a call right before its long result summarized both, the result's line a stub
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ModelRegistry, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { bytes, cap, flat, labeled, NODE, start, type Compression, type Compressor, type Kind } from '../src/memory.ts';
import { createCompressor as createCurrent } from '../src/compactor.ts';

const BASELINE = 'f860bc1';
const PROFILE = (() => {
  const profile = process.env.OPTCHAT_AB_PROFILE?.trim();
  if (!profile) throw new Error('Set OPTCHAT_AB_PROFILE explicitly; no personal profile is selected by default.');
  return profile;
})();
if (!process.argv.includes('--dry') && !process.argv.includes('--report') && !process.argv.includes('--allow-provider-calls')) {
  throw new Error('Provider calls require --allow-provider-calls; use --dry to inspect the experiment first.');
}
const DAYS = ['2026-10-21', '2026-10-22'];
const arg = (name: string) => { const at = process.argv.indexOf(name); return at >= 0 ? process.argv[at + 1] : undefined; };
const DRY = process.argv.includes('--dry');
const STAGE = (arg('--stage') ?? 'standing') as 'standing' | 'pairs';
const MAX_REQUESTS = Number(arg('--max-requests') ?? (STAGE === 'standing' ? 60 : 150));
const DATE = arg('--date') ?? new Date().toISOString().slice(0, 10);
const COUNTS = { pairs: Number(arg('--pairs') ?? 22), rich: 10, user: 4, talk: 4, merges1: 6, merges2: 2, leaves: Number(arg('--leaves') ?? 9), standingMerges1: Number(arg('--merges') ?? 6), standingMerges2: 2 };
const OUT = resolve(import.meta.dirname, '..', 'scratchpad', 'benchmarks');
const RESULT_FILE = join(OUT, `summary-ab-${DATE}-${STAGE}.json`);
const STANDING_FROM = 43_500;
const SEED = 20261022, VIEW_WINDOW = 512, VIEW_LEAVES = 12, STANDING_LINES = 12, MAX_FACTS = 10;

interface Entry { i: number; kind: Kind; text: string }
interface Node { l: number; i: number; text: string }
const readJsonl = <T>(file: string): T[] => readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as T);
const entries = DAYS.flatMap(day => readJsonl<Entry>(join(PROFILE, 'main', `${day}.jsonl`)));
const nodes = new Map<string, Node>();
for (const day of DAYS) for (const node of readJsonl<Node>(join(PROFILE, 'tree', `${day}.jsonl`))) if (typeof node.l === 'number') nodes.set(`${node.l}:${node.i}`, node);
const first = entries[0].i, byIndex = new Map(entries.map(entry => [entry.i, entry]));
const node = (l: number, i: number) => nodes.get(`${l}:${i}`);
const MIN_INDEX = STAGE === 'standing' ? STANDING_FROM : first + 700;

function rng(seed: number) {
  let a = seed;
  return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function pick<T>(items: T[], count: number, seed: number) {
  const random = rng(seed), pool = [...items], chosen: T[] = [];
  while (chosen.length < count && pool.length) chosen.push(pool.splice(Math.floor(random() * pool.length), 1)[0]);
  return chosen;
}

/** The bounded <chat> every variant sees: the real tree's coarse lines for the 512 messages before the item, then its last 12 leaves. */
function viewBefore(boundary: number, detail?: Node[]) {
  const lines: { text: string; leaf: boolean }[] = [];
  const line = (l: number, i: number, text: string, leaf: boolean) => lines.push({ text: `${start({ l, i })}+${2 ** l}|${flat(text)}`, leaf });
  const leavesFrom = boundary - VIEW_LEAVES;
  for (let at = leavesFrom - VIEW_WINDOW; at < leavesFrom;) {
    let l = 6;
    while (l > 0 && (at % 2 ** l || at + 2 ** l > leavesFrom || !node(l, at / 2 ** l))) l--;
    const n = node(l, at / 2 ** l);
    if (n) line(l, at / 2 ** l, n.text, false);
    at += 2 ** l;
  }
  for (let i = leavesFrom; i < boundary; i++) { const n = node(0, i); if (n) line(0, i, n.text, true); }
  const standing = lines.filter(l => l.leaf).slice(-STANDING_LINES).map(l => l.text);
  for (const n of detail ?? []) line(n.l, n.i, n.text, true);
  return { view: `<chat>\n${lines.map(l => l.text).join('\n')}\n</chat>`, standing };
}

// ---- Facts ----
type Category = 'num' | 'exit' | 'test' | 'path' | 'err' | 'id';
const CATEGORIES: Category[] = ['num', 'exit', 'test', 'path', 'err', 'id'];
interface Fact { category: Category; value: string }
const norm = (s: string) => s.toLowerCase().replace(/\\/g, '/').replace(/(\d),(?=\d{3}\b)/g, '$1');
function extractFacts(text: string): Fact[] {
  const seen = new Set<string>(), perCategory = new Map<Category, number>(), facts: Fact[] = [];
  const add = (category: Category, raw: string) => {
    const value = category === 'path' ? norm(raw).split('/').pop()! : norm(raw);
    const key = `${category}:${value}`;
    if (!value || seen.has(key) || (perCategory.get(category) ?? 0) >= MAX_FACTS) return;
    seen.add(key); perCategory.set(category, (perCategory.get(category) ?? 0) + 1); facts.push({ category, value });
  };
  for (const m of text.matchAll(/\b(?:exit(?:ed)?(?:\s+with)?(?:\s+code)?|rc|returncode|status(?:\s+code)?)\s*[=:]?\s*(-?\d+)\b/gi)) add('exit', m[1]);
  for (const m of text.matchAll(/\b(\d+)\s*(?:\/\s*\d+\s*)?(?:tests?|specs?|passed|passing|failed|failing|failures?|skipped|pass|fail)\b/gi)) add('test', m[1]);
  for (const m of text.matchAll(/\b(?:pass(?:ed)?|fail(?:ed)?|tests?|skipped)\s*[:=]?\s*(\d+)\b/gi)) add('test', m[1]);
  for (const m of text.matchAll(/(?<![\w.])(\d[\d,]*(?:\.\d+)?)\s?(?:%|ms|s|sec|secs|seconds|min|minutes|kb|mb|gb|bytes|files?|lines?|errors?|warnings?|items?|rows?|matches|commits?|chars|characters|hours?)(?![A-Za-z])/gi)) add('num', m[1]);
  for (const m of text.matchAll(/(?:[A-Za-z]:)?[\\/]?(?:[\w.@~+-]+[\\/])+[\w.@+-]+\.[A-Za-z]\w{0,7}\b|\b[\w@+-]+\.(?:ts|tsx|js|mjs|cjs|json|md|py|rs|cs|ps1|sh|sql|gxp|xml|log|yml|yaml|toml|txt|csv|html|css|lock|exe|dll|kt|java|go)\b/g))
    if (/[A-Za-z]/.test(m[0]) && m[0].length >= 4) add('path', m[0]);
  for (const m of text.matchAll(/\b[A-Z][A-Za-z0-9]*(?:Error|Exception|Failure|Timeout)\b|\b(?:E[A-Z]{3,}|ERR_[A-Z_]+|[A-Z]{2,}\d{3,5}|TS\d{4}|CS\d{4}|MSB\d{4}|HTTP\s?[45]\d\d)\b|\b[a-z]+(?:_[a-z]+)*_(?:error|failed|failure|not_found|timeout|denied)\b/g)) add('err', m[0]);
  for (const m of text.matchAll(/\b[0-9a-f]{7,40}\b/gi)) if (/\d/.test(m[0]) && /[a-f]/i.test(m[0])) add('id', m[0].slice(0, 7));
  for (const m of text.matchAll(/\b(?=[a-z0-9-]*\d)[a-z0-9]{6,10}-[a-z0-9]{5,8}\b/g)) add('id', m[0]);
  return facts;
}
/** A fact survives when the output still carries it (numbers need a nearby word of their kind, so "3" in a path is not a test count). */
function survives(fact: Fact, output: string) {
  const out = norm(output);
  switch (fact.category) {
    case 'exit': return new RegExp(`(?:exit|rc|code|status|returned?)\\D{0,15}${fact.value}(?!\\d)`).test(out);
    case 'test': return new RegExp(`(?<![\\d.])${fact.value}(?!\\d)[^.\\n]{0,25}(?:pass|fail|test|skip|spec|ok|green)|(?:pass|fail|test|skip|spec|ok|green)\\D{0,25}(?<![\\d.])${fact.value}(?!\\d)`).test(out);
    case 'num': return new RegExp(`(?<![\\w.])${fact.value.replace(/\./g, '\\.')}(?![\\d])`).test(out);
    default: return out.includes(fact.value);
  }
}
const words = (s: string) => s.toLowerCase().match(/[a-z0-9_.\\/*`-]+/g) ?? [];
const grams = (s: string) => { const w = words(s), set = new Set<string>(); for (let i = 0; i + 4 <= w.length; i++) set.add(w.slice(i, i + 4).join(' ')); return set; };
/** Share of the output's words covered by a 4-word phrase that most of the preceding lines already repeat (standing context restated). */
function standingShare(output: string, standing: string[]) {
  if (standing.length < 6) return undefined;
  const counts = new Map<string, number>();
  for (const line of standing) for (const g of grams(line)) counts.set(g, (counts.get(g) ?? 0) + 1);
  const phrases = new Set([...counts].filter(([, n]) => n >= standing.length / 2).map(([g]) => g));
  const w = words(output), covered = new Array(w.length).fill(false);
  for (let i = 0; i + 4 <= w.length; i++) if (phrases.has(w.slice(i, i + 4).join(' '))) for (let j = i; j < i + 4; j++) covered[j] = true;
  return w.length ? covered.filter(Boolean).length / w.length : 0;
}
function mergeRepeats(a: string, b: string, output: string) {
  const ga = grams(a), shared = [...grams(b)].filter(g => ga.has(g));
  const w = words(output).join(' ');
  let kept = 0, repeated = 0;
  for (const g of shared) { const n = w.split(g).length - 1; if (n >= 1) kept++; if (n >= 2) repeated++; }
  return { shared: shared.length, kept, repeated };
}

/** Written into the standing-stage result file before the first request. */
const PREREGISTERED = {
  question: 'Does V1 (LEAF_DELTA, MERGE_ONCE, CALL_ACTION_ONLY) reduce restated standing constraints and bytes against V0 (main f860bc1) without losing facts?',
  sample: `Haiku, high thinking, V0 and V1 only. Items from index >= ${STANDING_FROM} (where the boilerplate lives in the real tree). Leaves: messages over 512 bytes whose 12 preceding leaf lines share at least one standing 4-word phrase (a phrase in at least half of them), requests built as in production (a tool leaf carries its result, an echo leaf its call). Merges: adjacent line pairs (l=1, l=2) over 512 bytes whose two children share a 4-word phrase. Request cap 60 for the whole stage.`,
  primaryMetrics: {
    leaf: 'standingShare: fraction of output words covered by a standing 4-word phrase of the preceding context; bytes per leaf',
    merge: 'repeatedConstraints: standing constraints (4-word phrases both children share, and the curated live phrases) that occur 2+ times in the merged line, counted per merge; lostConstraints: curated phrases in both children absent from the merge; bytes per merge; standingShare',
  },
  gate: 'recall of facts per category (num, exit, test, path, err, id; facts taken from the item source) must not drop against V0 by more than 2 points, or by more than 1 fact when the category has 4 facts or fewer; leaves and merges are judged separately',
  keepV1When: [
    'R1 repetition falls: mean leaf standingShare V1 < V0 (strict) and, over merges, repeatedConstraints V1 <= V0 and mean merge standingShare V1 <= V0',
    'R2 bytes fall: mean bytes per leaf V1 < V0 and mean bytes per merge V1 <= 1.02 x V0',
    'R3 the recall gate holds for leaves and for merges',
    'R4 at least 6 leaves and 6 merges succeeded in both variants',
  ],
  otherwise: 'revert src/prompts.ts, src/compactor.ts and test/compactor-size.test.ts to f860bc1; keep the benchmark script and results',
};

/** The standing constraints the live lines repeat (index 43500 and up), counted by plain substring: in both children, how often in the merge. */
const CURATED = ['uncommitted', 'unpublished', 'no publish', 'keep edits', 'build.ps1', 'teste', 'kb_version', 'sdk fallback', 'unverified'];
function curatedRepeats(a: string, b: string, output: string) {
  const la = a.toLowerCase(), lb = b.toLowerCase(), lo = output.toLowerCase();
  let both = 0, repeated = 0, lost = 0;
  for (const phrase of CURATED) {
    if (!la.includes(phrase) || !lb.includes(phrase)) continue;
    both++;
    const n = lo.split(phrase).length - 1;
    if (n > 1) repeated += n - 1;
    if (n === 0) lost++;
  }
  return { curatedBoth: both, curatedRepeated: repeated, curatedLost: lost };
}

// ---- Sample ----
type ItemKind = 'pair' | 'talk' | 'merge' | 'leaf';
interface Item { id: string; kind: ItemKind; stratum?: 'random' | 'fact-rich'; callId?: number; echoId?: number; messageId?: number; part?: { l: number; i: number } }
function sample(): Item[] {
  const isPair = (i: number) => {
    const call = byIndex.get(i), echo = byIndex.get(i + 1);
    return call?.kind === 'tool' && echo?.kind === 'echo' && byIndex.get(i - 1)?.kind !== 'tool' && echo.text.startsWith(`${call.text.split(' ', 1)[0]}:`)
      && bytes(`echo: ${echo.text}`) > NODE && i >= MIN_INDEX && !!node(0, i) && !!node(0, i + 1);
  };
  // Most real results only name files, so 10 of the pairs are drawn from those carrying at least 3 non-path facts (counts, exit codes, ids, errors).
  const candidates = entries.filter(e => isPair(e.i)).map(e => e.i);
  const rich = candidates.filter(i => extractFacts(`tool: ${byIndex.get(i)!.text}
echo: ${byIndex.get(i + 1)!.text}`).filter(f => f.category !== 'path').length >= 3);
  const richPick = pick(rich, Math.min(COUNTS.rich, COUNTS.pairs), SEED + 3), richSet = new Set(richPick);
  const pairs = [...richPick, ...pick(candidates.filter(i => !richSet.has(i)), COUNTS.pairs - richPick.length, SEED)].sort((a, b) => a - b)
    .map<Item>(i => ({ id: `pair:${i}`, kind: 'pair', callId: i, echoId: i + 1, stratum: richSet.has(i) ? 'fact-rich' : 'random' }));
  const talkOf = (kind: Kind, count: number) => pick(entries.filter(e => e.kind === kind && e.i >= MIN_INDEX && bytes(`${kind}: ${e.text}`) > NODE).map(e => e.i), count, SEED + (kind === 'user' ? 1 : 2))
    .sort((a, b) => a - b).map<Item>(i => ({ id: `${kind}:${i}`, kind: 'talk', messageId: i }));
  const mergeOf = (l: number, count: number) => pick([...nodes.values()].filter(n => n.l === l && n.i * 2 ** l >= MIN_INDEX && node(l - 1, 2 * n.i) && node(l - 1, 2 * n.i + 1)
    && bytes(flat(node(l - 1, 2 * n.i)!.text) + '\n' + flat(node(l - 1, 2 * n.i + 1)!.text)) > NODE).map(n => n.i), count, SEED + 10 + l)
    .sort((a, b) => a - b).map<Item>(i => ({ id: `merge:${l}+${i}`, kind: 'merge', part: { l, i } }));
  if (STAGE === 'standing') return standingSample();
  return [...pairs, ...talkOf('user', COUNTS.user), ...talkOf('talk', COUNTS.talk), ...mergeOf(1, COUNTS.merges1), ...mergeOf(2, COUNTS.merges2)];
}

// ---- Variants ----
type VariantName = 'V0' | 'V1' | 'V2';
const VARIANTS: VariantName[] = ['V0', 'V1'];
interface Line { text: string; model: boolean; requests: number; ms: number; source: 'model' | 'verbatim' | 'stub' }
interface Result { variant: VariantName; item: string; ok: boolean; error?: string; lines: Line[]; bytes: number; requests: number; ms: number; maxMs: number;
  recall?: Record<string, [number, number]>; recallByOrigin?: Record<string, [number, number]>; standingShare?: number; merge?: { shared: number; kept: number; repeated: number; childBytes: number; curatedBoth: number; curatedRepeated: number; curatedLost: number } }

const budget = { requests: 0, consecutiveFailures: 0, stop: undefined as string | undefined };
function loadBaseline() {
  const dir = join(OUT, `baseline-${BASELINE}`);
  if (!existsSync(join(dir, 'src', 'compactor.ts'))) {
    mkdirSync(dir, { recursive: true });
    const tar = join(dir, 'src.tar');
    execFileSync('git', ['archive', '--format=tar', `--output=${tar}`, BASELINE, 'src'], { cwd: resolve(import.meta.dirname, '..') });
    execFileSync('tar', ['-xf', 'src.tar'], { cwd: dir });
  }
  return dir;
}

const byIndexEnd = () => entries[entries.length - 1].i;
const phrasesOf = (lines: string[]) => {
  const counts = new Map<string, number>();
  for (const line of lines) for (const g of grams(line)) counts.set(g, (counts.get(g) ?? 0) + 1);
  return [...counts].filter(([, n]) => n >= lines.length / 2).length;
};
function standingSample(): Item[] {
  const leaves = entries.filter(e => e.i >= STANDING_FROM && e.i < byIndexEnd() - 50 && bytes(`${e.kind}: ${e.text}`) > NODE && !!node(0, e.i) && phrasesOf(viewBefore(e.i).standing) >= 1).map(e => e.i);
  const mergeOf = (l: number, count: number) => pick([...nodes.values()].filter(n => n.l === l && n.i * 2 ** l >= STANDING_FROM && (n.i + 1) * 2 ** l < byIndexEnd() - 50 && node(l - 1, 2 * n.i) && node(l - 1, 2 * n.i + 1)
    && bytes(flat(node(l - 1, 2 * n.i)!.text) + ' ' + flat(node(l - 1, 2 * n.i + 1)!.text)) > NODE
    && mergeRepeats(node(l - 1, 2 * n.i)!.text, node(l - 1, 2 * n.i + 1)!.text, '').shared > 0).map(n => n.i), count, SEED + 20 + l)
    .sort((a, b) => a - b).map<Item>(i => ({ id: `merge:${l}+${i}`, kind: 'merge', part: { l, i } }));
  const leafItems = pick(leaves, COUNTS.leaves, SEED + 30).sort((a, b) => a - b).map<Item>(i => ({ id: `leaf:${i}`, kind: 'leaf', messageId: i }));
  const merges = [...mergeOf(1, COUNTS.standingMerges1), ...mergeOf(2, COUNTS.standingMerges2)];
  // Alternate merges and leaves so a stop for budget never leaves one kind unmeasured.
  const mixed: Item[] = [];
  for (let k = 0; k < Math.max(leafItems.length, merges.length); k++) { if (merges[k]) mixed.push(merges[k]); if (leafItems[k]) mixed.push(leafItems[k]); }
  return mixed;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  // The live log keeps growing, so a resumed run reuses the sample its result file recorded instead of drawing again.
  const items: Item[] = existsSync(RESULT_FILE) ? (JSON.parse(readFileSync(RESULT_FILE, 'utf8')) as { sample: Item[] }).sample : sample();
  const needsModel = (item: Item) => item.kind === 'pair' ? (bytes(`tool: ${byIndex.get(item.callId!)!.text}`) > NODE ? 1 : 0) + 1 : 1;
  if (DRY) {
    for (const item of items) {
      const at = item.callId ?? item.messageId ?? item.part!.i * 2 ** item.part!.l;
      const { view, standing } = viewBefore(at);
      const truth = item.kind === 'pair' ? `tool: ${byIndex.get(item.callId!)!.text}
echo: ${byIndex.get(item.echoId!)!.text}` : item.messageId !== undefined ? byIndex.get(item.messageId)!.text : '';
      console.log(item.id, `model calls ${needsModel(item)}, view ${bytes(view)}B, standing lines ${standing.length}, standing phrases ${phrasesOf(standing)}, facts`, JSON.stringify(Object.fromEntries(CATEGORIES.map(c => [c, extractFacts(truth).filter(f => f.category === c).length]))));
    }
    const calls = items.reduce((n, item) => n + needsModel(item), 0);
    console.log(`planned compactor calls (before too-long retries): V0 ${calls}, V1 ${calls}; total ${2 * calls}; cap ${MAX_REQUESTS}`);
    return;
  }
  const choice = (JSON.parse(readFileSync(join(PROFILE, 'config.json'), 'utf8')) as { compactor: { provider: string; model: string; thinking: 'high' } }).compactor;
  const runtime = await ModelRuntime.create();
  const real = new ModelRegistry(runtime);
  // Counts and caps every provider request; the compressor sees this in place of the registry.
  const counted = {
    find: (provider: string, model: string) => real.find(provider, model),
    streamSimple: (...args: Parameters<ModelRegistry['streamSimple']>) => {
      if (budget.requests >= MAX_REQUESTS) { budget.stop = 'request budget exhausted'; throw new Error('request budget exhausted'); }
      budget.requests++;
      return real.streamSimple(...args);
    },
  } as unknown as ModelRegistry;
  const baseline = await import(pathToFileURL(join(loadBaseline(), 'src', 'compactor.ts')).href) as { createCompressor: typeof createCurrent };
  // V1 is the working tree's src unless --v1-dir names a directory holding another src (the measured V1 is kept in scratchpad/benchmarks/variant-v1).
  const v1Dir = arg('--v1-dir');
  const v1 = v1Dir ? await import(pathToFileURL(join(resolve(v1Dir), 'src', 'compactor.ts')).href) as { createCompressor: typeof createCurrent } : { createCompressor: createCurrent };
  const compressors: Partial<Record<VariantName, Compressor>> = {
    V0: baseline.createCompressor(counted, () => choice, () => {}, () => 512, [1000]),
    V1: v1.createCompressor(counted, () => choice, () => {}, () => 512, [1000]),
  };
  const done: Record<string, Result> = existsSync(RESULT_FILE) ? Object.fromEntries((JSON.parse(readFileSync(RESULT_FILE, 'utf8')) as { results: Result[] }).results.map(r => [`${r.variant}|${r.item}`, r])) : {};
  const prior = existsSync(RESULT_FILE) ? (JSON.parse(readFileSync(RESULT_FILE, 'utf8')) as { requests: number }).requests : 0;
  budget.requests = prior;
  const save = () => writeFileSync(RESULT_FILE, JSON.stringify({ date: DATE, stage: STAGE, baseline: BASELINE, profile: basename(PROFILE), choice, requests: budget.requests, maxRequests: MAX_REQUESTS,
    ...(STAGE === 'standing' ? { preregistered: PREREGISTERED } : {}), sample: items, results: Object.values(done) }, null, 1));
  save(); // the sample and, for the standing stage, the rule are on disk before the first request

  const run = async (variant: VariantName, input: Compression, source: string, kind?: Kind): Promise<Line> => {
    const before = budget.requests, t0 = performance.now();
    const text = (await compressors[variant]!(input, new AbortController().signal)).trim();
    return { text: kind && text && text !== source ? labeled(kind, text) : text, model: true, requests: budget.requests - before, ms: Math.round(performance.now() - t0), source: 'model' };
  };
  const verbatim = (text: string): Line => ({ text, model: false, requests: 0, ms: 0, source: 'verbatim' });

  async function execute(variant: VariantName, item: Item): Promise<Line[] | { merge: Line; childA: string; childB: string }> {
    if (item.kind === 'pair') {
      const call = byIndex.get(item.callId!)!, echo = byIndex.get(item.echoId!)!;
      const callSource = `tool: ${call.text}`, echoSource = `echo: ${echo.text}`;
      const callView = viewBefore(call.i).view, echoView = viewBefore(echo.i).view;
      const callPart = { l: 0, i: call.i }, echoPart = { l: 0, i: echo.i };
      const callLine = bytes(callSource) <= NODE ? verbatim(callSource)
        : await run(variant, { context: callView, source: callSource, part: callPart, result: cap(echo.text, 12_000) }, callSource, 'tool');
      const echoLine = await run(variant, { context: echoView, source: cap(echoSource), part: echoPart, call: { i: call.i, text: cap(callSource, 4000) } }, cap(echoSource), 'echo');
      return [callLine, echoLine];
    }
    if (item.kind === 'talk') {
      const e = byIndex.get(item.messageId!)!, source = `${e.kind}: ${e.text}`;
      return [await run(variant, { context: viewBefore(e.i).view, source, part: { l: 0, i: e.i } }, source, e.kind)];
    }
    if (item.kind === 'leaf') {
      // As Memory.build does: a call carries the result that directly follows it, a result the call it answers.
      const e = byIndex.get(item.messageId!)!, source = e.kind === 'echo' ? cap(`echo: ${e.text}`) : `${e.kind}: ${e.text}`;
      const next = byIndex.get(e.i + 1), before = byIndex.get(e.i - 1);
      const result = e.kind === 'tool' && next?.kind === 'echo' && byIndex.get(e.i - 1)?.kind !== 'tool' && next.text.startsWith(`${e.text.split(' ', 1)[0]}:`) ? cap(next.text, 12_000) : undefined;
      const call = e.kind === 'echo' && before?.kind === 'tool' && byIndex.get(e.i - 2)?.kind !== 'tool' && e.text.startsWith(`${before.text.split(' ', 1)[0]}:`) ? { i: before.i, text: cap(`tool: ${before.text}`, 4000) } : undefined;
      return [await run(variant, { context: viewBefore(e.i).view, source, part: { l: 0, i: e.i }, ...(result === undefined ? {} : { result }), ...(call ? { call } : {}) }, source, e.kind)];
    }
    const { l, i } = item.part!, a = node(l - 1, 2 * i)!, b = node(l - 1, 2 * i + 1)!;
    const source = `${flat(a.text)}\n${flat(b.text)}`;
    const detail = l <= 2 ? Array.from({ length: 2 ** l }, (_, k) => node(0, i * 2 ** l + k)).filter((n): n is Node => !!n) : undefined;
    const merge = await run(variant, { context: viewBefore(i * 2 ** l, detail).view, source, part: { l, i } }, source);
    return { merge, childA: a.text, childB: b.text };
  }

  // Non-pairs first: if the request budget runs out, it is the last pairs that go unmeasured, never the merges.
  for (const item of [...items.filter(i => i.kind !== 'pair'), ...items.filter(i => i.kind === 'pair')]) for (const variant of VARIANTS) {
    const key = `${variant}|${item.id}`;
    if (done[key]?.ok) continue;
    if (budget.stop || budget.consecutiveFailures >= 2) break;
    if (MAX_REQUESTS - budget.requests < 3) { budget.stop = 'request budget nearly exhausted; not starting another item'; break; }
    const t0 = performance.now(), before = budget.requests;
    let result: Result;
    try {
      const out = await execute(variant, item);
      const lines = Array.isArray(out) ? out : [out.merge];
      const text = lines.map(l => l.text).join('\n');
      result = { variant, item: item.id, ok: true, lines, bytes: lines.reduce((n, l) => n + bytes(flat(l.text)), 0), requests: budget.requests - before,
        ms: lines.reduce((n, l) => n + l.ms, 0), maxMs: Math.max(...lines.map(l => l.ms)) };
      let standing: string[];
      if (item.kind === 'pair') {
        const call = byIndex.get(item.callId!)!, echo = byIndex.get(item.echoId!)!;
        const fromCall = extractFacts(`tool: ${call.text}`), fromResult = extractFacts(`echo: ${echo.text}`);
        const both = [...fromCall.map(f => ({ ...f, origin: 'call' })), ...fromResult.filter(f => !fromCall.some(c => c.category === f.category && c.value === f.value)).map(f => ({ ...f, origin: 'result' }))];
        result.recall = Object.fromEntries(CATEGORIES.map(c => { const fs = both.filter(f => f.category === c); return [c, [fs.filter(f => survives(f, text)).length, fs.length] as [number, number]]; }));
        result.recallByOrigin = Object.fromEntries(['call', 'result'].map(o => { const fs = both.filter(f => f.origin === o); return [o, [fs.filter(f => survives(f, text)).length, fs.length] as [number, number]]; }));
        standing = viewBefore(call.i).standing;
      } else if (item.kind === 'talk' || item.kind === 'leaf') {
        const e = byIndex.get(item.messageId!)!;
        const fs = extractFacts(`${e.kind}: ${e.text}`);
        result.recall = Object.fromEntries(CATEGORIES.map(c => { const sub = fs.filter(f => f.category === c); return [c, [sub.filter(f => survives(f, text)).length, sub.length] as [number, number]]; }));
        standing = viewBefore(e.i).standing;
      } else {
        const m = out as { merge: Line; childA: string; childB: string };
        const fs = extractFacts(`${m.childA}\n${m.childB}`);
        result.recall = Object.fromEntries(CATEGORIES.map(c => { const sub = fs.filter(f => f.category === c); return [c, [sub.filter(f => survives(f, text)).length, sub.length] as [number, number]]; }));
        result.merge = { ...mergeRepeats(m.childA, m.childB, text), ...curatedRepeats(m.childA, m.childB, text), childBytes: bytes(flat(m.childA)) + bytes(flat(m.childB)) };
        const { l, i } = item.part!;
        standing = viewBefore(i * 2 ** l).standing;
      }
      result.standingShare = standingShare(text, standing);
      budget.consecutiveFailures = 0;
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 300);
      result = { variant, item: item.id, ok: false, error: message, lines: [], bytes: 0, requests: budget.requests - before, ms: Math.round(performance.now() - t0), maxMs: 0 };
      if (!budget.stop) budget.consecutiveFailures++;
      console.error(`FAIL ${key}: ${message}`);
    }
    done[key] = result;
    save();
    console.log(`${key} ok=${result.ok} bytes=${result.bytes} requests=${result.requests} ms=${result.ms} total=${budget.requests}`);
  }
  save();
  if (budget.stop || budget.consecutiveFailures >= 2) { console.error(`STOPPED: ${budget.stop ?? 'two consecutive failures'}`); process.exitCode = 3; }
  console.log(`requests used: ${budget.requests}/${MAX_REQUESTS}`);
}

// ---- Report ----
const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? (s[Math.floor((s.length - 1) / 2)] + s[Math.ceil((s.length - 1) / 2)]) / 2 : NaN; };
const fixed = (n: number, d = 1) => Number.isNaN(n) ? 'n/a' : n.toFixed(d);
const pct = ([hit, total]: [number, number]) => total ? `${(100 * hit / total).toFixed(1)}% (${hit}/${total})` : 'n/a (0)';
function report() {
  const file = JSON.parse(readFileSync(RESULT_FILE, 'utf8')) as { date: string; stage: string; requests: number; maxRequests: number; sample: Item[]; results: Result[]; choice: unknown; preregistered?: typeof PREREGISTERED };
  if (file.stage === 'standing') return reportStanding(file);
  const VARIANTS = [...new Set(file.results.map(r => r.variant))].sort();
  const all = file.results, ok = (variant: VariantName, kind: ItemKind) => all.filter(r => r.variant === variant && r.ok && file.sample.find(i => i.id === r.item)?.kind === kind);
  const sum = (rs: Result[], c: string): [number, number] => rs.reduce<[number, number]>((acc, r) => [acc[0] + (r.recall?.[c]?.[0] ?? 0), acc[1] + (r.recall?.[c]?.[1] ?? 0)], [0, 0]);
  const total = (rs: Result[]): [number, number] => CATEGORIES.reduce<[number, number]>((acc, c) => { const [h, t] = sum(rs, c); return [acc[0] + h, acc[1] + t]; }, [0, 0]);
  const failed = (variant: VariantName) => all.filter(r => !r.ok && r.variant === variant).length;
  const out: string[] = [`# Summary A/B (${file.date}): compactor ${JSON.stringify(file.choice)}, ${file.requests}/${file.maxRequests} provider requests
`];
  const complete = file.sample.filter(i => i.kind === 'pair' && VARIANTS.every(v => all.some(r => r.variant === v && r.item === i.id && r.ok)));
  const only = (rs: Result[], ids: Set<string>) => rs.filter(r => ids.has(r.item));
  const ids = new Set(complete.map(i => i.id));
  out.push(`## Tool call + result pairs (${complete.length} of ${file.sample.filter(i => i.kind === 'pair').length} succeeded in all variants; rows use those)
`);
  out.push(`| | ${VARIANTS.join(' | ')} |`, `|---|${VARIANTS.map(() => '---').join('|')}|`);
  const rows = VARIANTS.map(v => only(ok(v, 'pair'), ids));
  const row = (label: string, f: (rs: Result[]) => string) => out.push(`| ${label} | ${rows.map(f).join(' | ')} |`);
  row('bytes per pair (mean / median)', rs => `${fixed(mean(rs.map(r => r.bytes)))} / ${fixed(median(rs.map(r => r.bytes)))}`);
  row('compactor calls per pair (requests, incl. too-long retries)', rs => fixed(mean(rs.map(r => r.requests)), 2));
  row('model lines per pair', rs => fixed(mean(rs.map(r => r.lines.filter(l => l.model).length)), 2));
  row('latency per pair, sum of lines (s)', rs => fixed(mean(rs.map(r => r.ms)) / 1000, 1));
  row('latency per pair, slowest line (s)', rs => fixed(mean(rs.map(r => r.maxMs)) / 1000, 1));
  for (const c of CATEGORIES) row(`recall ${c}`, rs => pct(sum(rs, c)));
  row('recall, all facts', rs => pct(total(rs)));
  row('recall of facts from the call text', rs => pct(rs.reduce<[number, number]>((a, r) => [a[0] + (r.recallByOrigin?.call?.[0] ?? 0), a[1] + (r.recallByOrigin?.call?.[1] ?? 0)], [0, 0])));
  row('recall of facts from the result text', rs => pct(rs.reduce<[number, number]>((a, r) => [a[0] + (r.recallByOrigin?.result?.[0] ?? 0), a[1] + (r.recallByOrigin?.result?.[1] ?? 0)], [0, 0])));
  row('output words restating standing context', rs => `${fixed(100 * mean(rs.flatMap(r => r.standingShare === undefined ? [] : [r.standingShare])))}%`);
  row('failed items (all pairs)', () => '');
  out[out.length - 1] = `| failed pairs | ${VARIANTS.map(v => failed(v) ? String(all.filter(r => !r.ok && r.variant === v && r.item.startsWith('pair:')).length) : '0').join(' | ')} |`;
  const richIds = new Set(complete.filter(i => i.stratum === 'fact-rich').map(i => i.id));
  out.push(`
Bytes per pair, fact-rich pairs (${richIds.size}): ${VARIANTS.map(v => `${v} ${fixed(mean(only(ok(v, 'pair'), richIds).map(r => r.bytes)))}`).join(', ')}; other pairs (${ids.size - richIds.size}): ${VARIANTS.map(v => `${v} ${fixed(mean(only(ok(v, 'pair'), new Set([...ids].filter(i => !richIds.has(i)))).map(r => r.bytes)))}`).join(', ')}.`);
  for (const [title, kind] of [['User/talk messages', 'talk'], ['Merges of two adjacent lines', 'merge']] as const) {
    const common = new Set(file.sample.filter(i => i.kind === kind && ['V0', 'V1'].every(v => all.some(r => r.variant === v && r.item === i.id && r.ok))).map(i => i.id));
    out.push(`
## ${title} (${common.size} items ok in both; V2 uses V1's prompts for these)
`, '| | V0 baseline | V1 prompts |', '|---|---|---|');
    const rs = ['V0', 'V1'].map(v => only(ok(v as VariantName, kind), common));
    const r2 = (label: string, f: (x: Result[]) => string) => out.push(`| ${label} | ${rs.map(f).join(' | ')} |`);
    r2('bytes per line (mean)', x => fixed(mean(x.map(r => r.bytes))));
    if (kind === 'merge') r2('child lines bytes (mean)', x => fixed(mean(x.map(r => r.merge?.childBytes ?? NaN))));
    r2('compactor calls per item', x => fixed(mean(x.map(r => r.requests)), 2));
    r2('latency (s)', x => fixed(mean(x.map(r => r.ms)) / 1000, 1));
    for (const c of CATEGORIES) r2(`recall ${c}`, x => pct(sum(x, c)));
    r2('recall, all facts', x => pct(total(x)));
    r2('output words restating standing context', x => `${fixed(100 * mean(x.flatMap(r => r.standingShare === undefined ? [] : [r.standingShare])))}%`);
    if (kind === 'merge') {
      r2('phrases both children share (4-word)', x => String(x.reduce((n, r) => n + (r.merge?.shared ?? 0), 0)));
      r2('...kept at least once in the merge', x => String(x.reduce((n, r) => n + (r.merge?.kept ?? 0), 0)));
      r2('...repeated (2+ times) in the merge', x => String(x.reduce((n, r) => n + (r.merge?.repeated ?? 0), 0)));
    }
    r2('failed', () => '');
    out[out.length - 1] = `| failed | ${['V0', 'V1'].map(v => all.filter(r => !r.ok && r.variant === v && file.sample.find(i => i.id === r.item)?.kind === kind).length).join(' | ')} |`;
  }
  const md = `${out.join('\n')}\n`;
  writeFileSync(join(OUT, `summary-ab-${DATE}-pairs.md`), md);
  console.log(md);
}
type StandingFile = { date: string; requests: number; maxRequests: number; sample: Item[]; results: Result[]; choice: unknown; preregistered?: typeof PREREGISTERED };
function reportStanding(file: StandingFile) {
  const all = file.results;
  const both = (kind: ItemKind) => new Set(file.sample.filter(i => i.kind === kind && ['V0', 'V1'].every(v => all.some(r => r.variant === v && r.item === i.id && r.ok))).map(i => i.id));
  const leafIds = both('leaf'), mergeIds = both('merge');
  const of = (v: VariantName, ids: Set<string>) => all.filter(r => r.ok && r.variant === v && ids.has(r.item));
  const sum = (rs: Result[], c: string): [number, number] => rs.reduce<[number, number]>((a, r) => [a[0] + (r.recall?.[c]?.[0] ?? 0), a[1] + (r.recall?.[c]?.[1] ?? 0)], [0, 0]);
  const total = (rs: Result[]): [number, number] => CATEGORIES.reduce<[number, number]>((a, c) => { const [h, t] = sum(rs, c); return [a[0] + h, a[1] + t]; }, [0, 0]);
  const share = (rs: Result[]) => 100 * mean(rs.flatMap(r => r.standingShare === undefined ? [] : [r.standingShare]));
  const mergeSum = (rs: Result[], f: (m: NonNullable<Result['merge']>) => number) => rs.reduce((n, r) => n + (r.merge ? f(r.merge) : 0), 0);
  const out: string[] = [`# Standing-context stage (${file.date}): V0 vs V1, Haiku (high), ${file.requests}/${file.maxRequests} provider requests
`];
  out.push(`Leaves ok in both: ${leafIds.size}/${file.sample.filter(i => i.kind === 'leaf').length}; merges ok in both: ${mergeIds.size}/${file.sample.filter(i => i.kind === 'merge').length}.
`);
  const table = (title: string, ids: Set<string>, extra: (rs: Result[]) => [string, string][]) => {
    const rs = [of('V0', ids), of('V1', ids)];
    out.push(`## ${title}
`, '| | V0 | V1 |', '|---|---|---|');
    const line = (label: string, f: (x: Result[]) => string) => out.push(`| ${label} | ${rs.map(f).join(' | ')} |`);
    line('bytes per line (mean)', x => fixed(mean(x.map(r => r.bytes))));
    line('compactor calls per item', x => fixed(mean(x.map(r => r.requests)), 2));
    line('latency (s)', x => fixed(mean(x.map(r => r.ms)) / 1000, 1));
    line('output words restating standing context', x => `${fixed(share(x))}%`);
    for (const c of CATEGORIES) line(`recall ${c}`, x => pct(sum(x, c)));
    line('recall, all facts', x => pct(total(x)));
    for (const [label, f] of extra(rs[0]).map((_, k) => [extra(rs[0])[k][0], k] as const)) line(label, x => extra(x)[f][1]);
    out.push('');
  };
  table('Leaves', leafIds, () => []);
  table('Merges', mergeIds, rs => [
    ['merge: 4-word phrases both children share', String(mergeSum(rs, m => m.shared))],
    ['...kept at least once', String(mergeSum(rs, m => m.kept))],
    ['...repeated 2+ times in the merge', String(mergeSum(rs, m => m.repeated))],
    ['curated live phrases in both children', String(mergeSum(rs, m => m.curatedBoth))],
    ['...repeated beyond once in the merge', String(mergeSum(rs, m => m.curatedRepeated))],
    ['...lost (absent from the merge)', String(mergeSum(rs, m => m.curatedLost))],
    ['child lines bytes (mean)', fixed(mean(rs.map(r => r.merge?.childBytes ?? NaN)))],
  ]);
  // Decision rule from PREREGISTERED.
  const gate = (ids: Set<string>) => CATEGORIES.map(c => {
    const [h0, t0] = sum(of('V0', ids), c), [h1, t1] = sum(of('V1', ids), c);
    const dropFacts = h0 - h1, dropPoints = t0 && t1 ? 100 * (h0 / t0 - h1 / t1) : 0;
    return { c, t0, h0, h1, pass: t0 <= 4 ? dropFacts <= 1 : dropPoints <= 2 };
  });
  const gl = gate(leafIds), gm = gate(mergeIds);
  const l0 = of('V0', leafIds), l1 = of('V1', leafIds), m0 = of('V0', mergeIds), m1 = of('V1', mergeIds);
  const r1 = share(l1) < share(l0) && mergeSum(m1, m => m.repeated + m.curatedRepeated) <= mergeSum(m0, m => m.repeated + m.curatedRepeated) && share(m1) <= share(m0);
  const r2 = mean(l1.map(r => r.bytes)) < mean(l0.map(r => r.bytes)) && mean(m1.map(r => r.bytes)) <= 1.02 * mean(m0.map(r => r.bytes));
  const r3 = [...gl, ...gm].every(g => g.pass), r4 = leafIds.size >= 6 && mergeIds.size >= 6;
  out.push('## Decision rule (recorded before the first request)', '');
  out.push(`- R1 repetition falls (leaf standing share V1 < V0; merge repeats V1 <= V0; merge standing share V1 <= V0): **${r1 ? 'PASS' : 'FAIL'}**`);
  out.push(`- R2 bytes fall (leaf V1 < V0; merge V1 <= 1.02 x V0): **${r2 ? 'PASS' : 'FAIL'}**`);
  out.push(`- R3 recall gate per category: **${r3 ? 'PASS' : 'FAIL'}** (leaves: ${gl.map(g => `${g.c} ${g.h0}->${g.h1}/${g.t0}${g.pass ? '' : ' FAIL'}`).join(', ')}; merges: ${gm.map(g => `${g.c} ${g.h0}->${g.h1}/${g.t0}${g.pass ? '' : ' FAIL'}`).join(', ')})`);
  out.push(`- R4 at least 6 leaves and 6 merges ok in both: **${r4 ? 'PASS' : 'FAIL'}**`);
  out.push('', `**Verdict: ${r1 && r2 && r3 && r4 ? 'keep V1' : 'revert to f860bc1 (apply A)'}**`);
  const md = `${out.join('\n')}\n`;
  writeFileSync(join(OUT, `summary-ab-${DATE}-standing.md`), md);
  console.log(md);
}
if (process.argv.includes('--report')) report(); else await main();
