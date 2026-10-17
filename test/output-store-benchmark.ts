import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, freemem, release, tmpdir, totalmem } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { OutputStore } from '../src/output-store.ts';

const MiB = 1024 * 1024;
const quotaBytes = 64 * MiB;
const seededRecordBytes = 512 * 1024;
const writeRecordBytes = 256 * 1024;
const sessions = 8;
const repetitions = 5;
const writesPerRepetition = 5;
const occupancies = [16, 40, 60].map(value => value * MiB);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

function content(label: string, bytes: number) {
  const suffix = `\n${label}`;
  if (Buffer.byteLength(suffix) > bytes) throw new Error('Benchmark label exceeds record size');
  return 'x'.repeat(bytes - Buffer.byteLength(suffix)) + suffix;
}

function seedProfile(profile: string, targetBytes: number) {
  const seed = JSON.stringify({ version: 1, created: 1, text: content('seed-0', seededRecordBytes) });
  const filesToWrite = Math.round(targetBytes / Buffer.byteLength(seed));
  let bytes = 0;
  for (let i = 0; i < filesToWrite; i++) {
    const session = `session-${i % sessions}`;
    const directory = join(profile, 'outputs', digest(session));
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const text = content(`seed-${i}`, seededRecordBytes);
    const record = JSON.stringify({ version: 1, created: 1, text });
    const file = join(directory, `${digest(text)}.json`);
    writeFileSync(file, record, { flag: 'wx', mode: 0o600 });
    bytes += Buffer.byteLength(record);
  }
  return { records: filesToWrite, bytes };
}

function percentile(values: number[], fraction: number) {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.ceil(ordered.length * fraction) - 1];
}

function parseOutputPath() {
  const argument = process.argv.slice(2).find(value => value.startsWith('--out='));
  return argument?.slice('--out='.length);
}

function main() {
  const outPath = parseOutputPath();
  if (!outPath) throw new Error('Provide --out=<ignored scratchpad JSON path>');
  const warmup = mkdtempSync(join(tmpdir(), 'optchat-output-bench-warmup-'));
  try {
    new OutputStore(warmup, 'warmup').put(content('warmup', 16 * 1024));
  } finally {
    rmSync(warmup, { recursive: true, force: true });
  }

  const results = [];
  for (const targetBytes of occupancies) {
    const samples: number[] = [];
    const repetitionMedians: number[] = [];
    const repetitionSamplesMs: number[][] = [];
    let records = 0, actualBytes = 0;
    for (let repetition = 0; repetition < repetitions; repetition++) {
      const profile = mkdtempSync(join(tmpdir(), 'optchat-output-bench-'));
      try {
        const seeded = seedProfile(profile, targetBytes);
        records = seeded.records;
        actualBytes = seeded.bytes;
        const store = new OutputStore(profile, 'current-session', { maxBytes: quotaBytes, now: () => 1 });
        const repetitionSamples: number[] = [];
        for (let write = 0; write < writesPerRepetition; write++) {
          const text = content(`probe-${targetBytes}-${repetition}-${write}`, writeRecordBytes);
          const start = performance.now();
          const ref = store.put(text);
          repetitionSamples.push(performance.now() - start);
          if (store.read(ref) !== text) throw new Error('Benchmark write failed integrity check');
        }
        samples.push(...repetitionSamples);
        repetitionMedians.push(percentile(repetitionSamples, 0.5));
        repetitionSamplesMs.push(repetitionSamples);
      } finally {
        rmSync(profile, { recursive: true, force: true });
      }
    }
    results.push({
      targetMiB: targetBytes / MiB,
      actualInitialMiB: actualBytes / MiB,
      sessions,
      records,
      writeMiB: writeRecordBytes / MiB,
      writesPerRepetition,
      repetitions,
      sampleCount: samples.length,
      medianMs: percentile(samples, 0.5),
      p90Ms: percentile(samples, 0.9),
      repetitionMedianMs: repetitionMedians,
      samplesMs: samples,
      repetitionSamplesMs,
    });
  }

  const result = {
    schema: 1,
    label: process.env.BENCH_LABEL ?? 'unlabeled',
    startedAt: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    host: {
      osRelease: release(),
      cpuModel: cpus()[0]?.model,
      logicalCpus: cpus().length,
      totalMemoryMiB: Math.round(totalmem() / MiB),
      freeMemoryAtStartMiB: Math.round(freemem() / MiB),
    },
    quotaMiB: quotaBytes / MiB,
    workload: 'Valid retained UTF-8 records across eight sessions; seed records are 512 KiB and measured successful writes are 256 KiB. Each repetition uses a fresh profile. Timer covers OutputStore.put, including quota scan, durable write, and integrity verification; the follow-up read check is outside the timer. Raw per-write timings and per-repetition medians are recorded below.',
    results,
  };
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
