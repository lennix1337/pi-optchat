// Memory benchmark for a realistic ~175k-message OptChat store and repeated live-session operations.
// Run: node --experimental-transform-types --expose-gc scripts/bench-memory.mjs [--messages 175000] [--days 50] [--views 200] [--turns 50] [--snapshot]
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import v8 from 'node:v8';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Memory } from '../src/memory.ts';
import { Focus } from '../src/focus.ts';
import { renderStatus } from '../src/sync.ts';
import { readHomeWork } from '../src/home-items.ts';
import { findInRange } from '../src/zoom-navigation.ts';

if (typeof globalThis.gc !== 'function') {
  console.error('Run with --expose-gc');
  process.exit(1);
}

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};

const MESSAGES = Number(arg('messages', '175000'));
const DAYS = Number(arg('days', '50'));
const VIEWS = Number(arg('views', '200'));
const TURNS = Number(arg('turns', '50'));
const WITH_SNAPSHOT = process.argv.includes('--snapshot');

const mb = (n) => Math.round((n / (1024 * 1024)) * 100) / 100;

function sample(label) {
  globalThis.gc();
  globalThis.gc();
  const m = process.memoryUsage();
  const spaces = Object.fromEntries(v8.getHeapSpaceStatistics().map((s) => [s.space_name, mb(s.space_used_size)]));
  const row = {
    label,
    heapUsedMB: mb(m.heapUsed),
    heapTotalMB: mb(m.heapTotal),
    externalMB: mb(m.external),
    arrayBuffersMB: mb(m.arrayBuffers),
    rssMB: mb(m.rss),
    oldSpaceMB: spaces.old_space ?? 0,
  };
  console.log(
    `${label.padEnd(28)} | heap=${String(row.heapUsedMB).padStart(7)} MB | ext=${String(row.externalMB).padStart(6)} MB | ab=${String(row.arrayBuffersMB).padStart(6)} MB | rss=${String(row.rssMB).padStart(7)} MB | old=${String(row.oldSpaceMB).padStart(7)} MB`
  );
  return row;
}

function summarizeHeap(tag) {
  const snapFile = join(tmpdir(), `optchat-bench-${process.pid}-${tag}.heapsnapshot`);
  const summaryScript = fileURLToPath(new URL('../src/heap-snapshot-summary.mjs', import.meta.url));
  v8.writeHeapSnapshot(snapFile);
  const res = spawnSync(process.execPath, [summaryScript, snapFile, '15'], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  try { rmSync(snapFile, { force: true }); } catch {}
  if (res.status !== 0) {
    console.error(`snapshot summary failed: ${res.stderr}`);
    return null;
  }
  return JSON.parse(res.stdout);
}

const dir = mkdtempSync(join(tmpdir(), 'optchat-rss-bench-'));
const memDir = join(dir, 'memory');
const kinds = ['user', 'talk', 'tool', 'echo', 'work'];

try {
  mkdirSync(join(memDir, 'main'), { recursive: true });
  mkdirSync(join(memDir, 'tree'), { recursive: true });
  mkdirSync(join(memDir, 'runs'), { recursive: true });

  const t0 = performance.now();
  const perDay = Math.ceil(MESSAGES / DAYS);
  const baseTime = Date.UTC(2026, 0, 1);

  for (let d = 0; d < DAYS; d++) {
    const dayStr = new Date(baseTime + d * 86_400_000).toISOString().slice(0, 10);
    const mainFile = join(memDir, 'main', `${dayStr}.jsonl`);
    const startI = d * perDay;
    const endI = Math.min(MESSAGES, startI + perDay);
    let buf = '';
    for (let i = startI; i < endI; i++) {
      const kind = kinds[i % kinds.length];
      const text = kind === 'echo'
        ? `read: line ${i} ${'payload content data '.repeat(12)}unique_token_${i % 997}`
        : kind === 'tool'
          ? `read {"path":"src/file_${i % 40}.ts","offset":${i}}`
          : `msg ${i} ${'realistic conversation text about optchat memory and tasks '.repeat(3)}ref_${i % 1009}`;
      const rec = {
        i,
        kind,
        text,
        date: new Date(baseTime + d * 86_400_000 + (i - startI) * 1000).toISOString(),
        ...(i % 17 === 0 ? { receipt: `report:${i}` } : {}),
      };
      buf += JSON.stringify(rec) + '\n';
      if (buf.length >= 256 * 1024) {
        appendFileSync(mainFile, buf);
        buf = '';
      }
    }
    if (buf) appendFileSync(mainFile, buf);
  }

  // Build summaries at every tree level across day files.
  let treeNodes = 0;
  let treeDay = 0;
  let treeFile = join(memDir, 'tree', `${new Date(baseTime).toISOString().slice(0, 10)}.jsonl`);
  let treeBuf = '';
  for (let l = 0; Math.floor(MESSAGES / 2 ** l) >= 1; l++) {
    const count = Math.floor(MESSAGES / 2 ** l);
    for (let i = 0; i < count; i++) {
      const text = `${kinds[i % kinds.length]}: summary level ${l} node ${i} covering ${2 ** l} messages with key facts and file paths`;
      treeBuf += JSON.stringify({ l, i, text }) + '\n';
      treeNodes++;
      if (treeBuf.length >= 256 * 1024) {
        appendFileSync(treeFile, treeBuf);
        treeBuf = '';
        if (treeNodes % 20000 === 0 && treeDay + 1 < DAYS) {
          treeDay++;
          treeFile = join(memDir, 'tree', `${new Date(baseTime + treeDay * 86_400_000).toISOString().slice(0, 10)}.jsonl`);
        }
      }
    }
  }
  if (treeBuf) appendFileSync(treeFile, treeBuf);

  // Write a realistic operational-state.json for renderStatus / readHomeWork
  writeFileSync(join(dir, 'operational-state.json'), JSON.stringify({
    version: 1,
    entries: [
      { id: 'op-1', text: 'Active deployment target', updatedAt: new Date().toISOString() },
      { id: 'op-2', text: 'Watch RSS < 500 MB', updatedAt: new Date().toISOString() },
    ],
  }));

  console.log(`Built synthetic store: messages=${MESSAGES}, days=${DAYS}, treeNodes=${treeNodes} in ${(performance.now() - t0).toFixed(0)} ms`);
  sample('baseline (before open)');

  const compressor = async (input) => `${input.part.l === 0 ? 'talk' : 'work'}: compressed ${input.part.l}:${input.part.i} ${input.source.slice(0, 80)}`;

  const openStart = performance.now();
  const memory = await Memory.open(memDir, compressor, () => {});
  const openMs = performance.now() - openStart;
  console.log(`Memory.open: ${openMs.toFixed(1)} ms | stats=${JSON.stringify(memory.stats())}`);
  const afterOpen = sample('after Memory.open');

  // Warm up focus & initial render
  const focus = new Focus();
  let lastView = memory.render();
  focus.observe({ id: 100, n: 1, kind: 'zoom', text: memory.zoom(100, 1) });
  focus.observe({ id: 50000, n: 1, kind: 'zoom', text: memory.zoom(50000, 1) });
  focus.render(memory);
  const afterWarmup = sample('after initial render+focus');

  // Repeated view builds (simulating N turns)
  const viewStart = performance.now();
  for (let v = 0; v < VIEWS; v++) {
    lastView = memory.render();
    focus.render(memory);
  }
  const viewMs = performance.now() - viewStart;
  console.log(`Built view + focus ${VIEWS}x in ${viewMs.toFixed(1)} ms (${(viewMs / VIEWS).toFixed(2)} ms/turn, viewBytes=${Buffer.byteLength(lastView)})`);
  const afterViews = sample(`after ${VIEWS} view builds`);

  // Zoom (tree + cold original + hot original)
  for (let z = 0; z < 50; z++) {
    memory.zoom(z * 1024, 64);
    memory.zoom(z * 1000 + 1, 1);
    memory.zoom(MESSAGES - 100 + (z % 50), 1);
  }
  const afterZoom = sample('after 150 zooms');

  // findText (zoom-navigation)
  for (let f = 0; f < 10; f++) {
    findInRange(memory, { id: 0, n: 131072, findText: `unique_token_${f * 13 + 7}` });
  }
  const afterFind = sample('after 10 findText');

  // search
  for (let s = 0; s < 10; s++) {
    memory.search(`unique_token_${s * 17 + 3}`);
  }
  const afterSearch = sample('after 10 memory.search');

  // status / Home rendering
  for (let r = 0; r < 50; r++) {
    renderStatus({ profile: 'bench', model: 'fixture/model', memory, operationalFile: join(dir, 'operational-state.json') });
    readHomeWork(dir, ['job-1 · npm test'], Date.now(), ['worker-1']);
  }
  const afterStatus = sample('after 50 status+Home');

  // Append + summarize N turns
  const turnStart = performance.now();
  for (let t = 0; t < TURNS; t++) {
    memory.append('user', `turn ${t} user prompt ${'word '.repeat(60)}`);
    memory.append('talk', `turn ${t} assistant response ${'reply '.repeat(60)}`);
    await memory.settle();
    lastView = memory.render();
    renderStatus({ profile: 'bench', model: 'fixture/model', memory, operationalFile: join(dir, 'operational-state.json') });
  }
  const turnMs = performance.now() - turnStart;
  console.log(`Append+summarize+render ${TURNS} turns in ${turnMs.toFixed(1)} ms (${(turnMs / TURNS).toFixed(2)} ms/turn)`);
  const afterTurns = sample(`after ${TURNS} append+summarize`);

  const viewGrowthKB = ((afterViews.heapUsedMB - afterWarmup.heapUsedMB) * 1024) / VIEWS;
  const turnGrowthKB = ((afterTurns.heapUsedMB - afterStatus.heapUsedMB) * 1024) / TURNS;
  console.log(`---`);
  console.log(`Per-view heap growth: ${viewGrowthKB.toFixed(2)} KB/view`);
  console.log(`Per-turn heap growth: ${turnGrowthKB.toFixed(2)} KB/turn`);
  console.log(`Final stats: ${JSON.stringify(memory.stats())}`);

  if (WITH_SNAPSHOT) {
    const snap = summarizeHeap('final');
    if (snap) {
      console.log('Top constructors by selfBytes:');
      for (const c of snap.topConstructors) {
        console.log(`  ${c.name.padEnd(28)} (${c.type.padEnd(7)}) count=${String(c.count).padStart(7)} self=${mb(c.selfBytes).toFixed(2)} MB`);
      }
      console.log('By type:', Object.entries(snap.byType).slice(0, 8).map(([k, v]) => `${k}=${mb(v.selfBytes).toFixed(2)}MB(${v.count})`).join(', '));
    }
  }

  await memory.close();
} finally {
  rmSync(dir, { recursive: true, force: true });
}
