#!/usr/bin/env node
// Publishes one observation to the OptChat signal spool, without the service and without a model.
//
//   node assistant/scripts/signal.mjs --profile swlucas05 --source ci --kind ci.failed \
//     --subject owner/repo#42 --summary "CI failed on the PR head" --dedupe ci:owner/repo:42:abc123
//
// A signal is data: the service stores it once and a fixed rule may enqueue a fixed-text notice. It never
// dispatches work, tools or messages on its own. The spool is drained by a service started with "signals":true.
import { appendFileSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { parseSignal, signalKinds, signalSources } from '../src/contracts/signals.ts';
import { ensureSpool } from '../src/journal/spool.ts';

const MAX_SPOOL_BYTES = 1024 * 1024;
const usage = `Usage: node assistant/scripts/signal.mjs --profile <id> --source <source> --kind <kind> --subject <subject> --summary <summary> [options]
Sources: ${signalSources.join(', ')}
Kinds:   ${signalKinds.join(', ')}
Options:
  --severity info|warning|critical   default warning
  --attention notify|wake            wake only when the producer suppressed an existing wake
  --dedupe <key>                     stable external-event id; default source:kind:subject:observedAt
  --correlation <id>                 task, run or PR correlation
  --evidence <reference>             observed reference; default signal:<id>
  --at <ISO-8601 UTC>                default now
  --help
Exit codes: 0 queued, 2 usage, 1 invalid or spool unavailable.`;

const flags = new Set(['profile', 'source', 'kind', 'subject', 'summary', 'severity', 'attention', 'dedupe', 'correlation', 'evidence', 'at', 'help']);
const values = {};
const argv = process.argv.slice(2);
for (let index = 0; index < argv.length; index++) {
  const arg = argv[index];
  if (!arg.startsWith('--')) { console.error(`Unexpected argument: ${arg}\n${usage}`); process.exit(2); }
  const name = arg.slice(2);
  if (!flags.has(name)) { console.error(`Unknown option: ${arg}\n${usage}`); process.exit(2); }
  if (name === 'help') { console.log(usage); process.exit(0); }
  const value = argv[++index];
  if (value === undefined || value.startsWith('--')) { console.error(`Missing value for ${arg}\n${usage}`); process.exit(2); }
  if (Object.hasOwn(values, name)) { console.error(`Repeated option: ${arg}`); process.exit(2); }
  values[name] = value;
}
for (const required of ['profile', 'source', 'kind', 'subject', 'summary']) {
  if (values[required] === undefined) { console.error(`Missing --${required}\n${usage}`); process.exit(2); }
}

const clean = (text) => String(text).replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, ' ').trim();
const signalId = randomUUID();
const observedAt = values.at ?? new Date().toISOString();
const signal = {
  version: 1, signalId, profileId: values.profile, source: values.source, kind: values.kind,
  severity: values.severity ?? 'warning', observedAt: clean(observedAt), dedupeKey: clean(values.dedupe ?? `${values.source}:${values.kind}:${clean(values.subject)}:${clean(observedAt)}`),
  subject: clean(values.subject), summary: clean(values.summary), correlationId: values.correlation === undefined ? null : clean(values.correlation),
  attention: values.attention ?? 'notify', evidence: { kind: 'observed', reference: clean(values.evidence ?? `signal:${signalId}`) },
};
try { parseSignal(signal); }
catch (error) { console.error(`Invalid signal: ${error instanceof Error ? error.message : String(error)}`); process.exit(1); }

let path;
try {
  path = ensureSpool(values.profile);
  const size = statSync(path, { throwIfNoEntry: false })?.size ?? 0;
  if (size > MAX_SPOOL_BYTES) throw new Error(`spool is over ${MAX_SPOOL_BYTES} bytes; is the service running with "signals":true?`);
  appendFileSync(path, `${JSON.stringify(signal)}\n`, { mode: 0o600 });
} catch (error) {
  console.error(`Could not queue signal: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
console.log(JSON.stringify({ result: 'queued', signalId, path }));
