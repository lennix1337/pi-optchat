#!/usr/bin/env node
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { loadConfig } from '../src/ops/service.ts';
import { prepareDatabase } from '../src/store/privacy.ts';
import { DisplayLearning, displayBinding } from '../src/memory/display-learning.ts';

const usage = `Usage: node assistant/scripts/display-learning.mjs <config> <propose|show|measure|approve|reject|apply|revert|current> [id version]
For propose, supply the candidate on stdin, not as an argument. Review displays the profile, exact proposal, version, baseline revision/hash, candidate hash and retained dataset hash. Approve, reject, apply and revert require a fresh typed confirmation in the local terminal; the database transaction rejects stale bindings. The dataset is synthetic and does not measure personal-learning efficacy.`;
const [, , path, action, arg, version] = process.argv;
if (!path || path === '--help' || !action) { console.log(usage); process.exit(path === '--help' ? 0 : 2); }
let learning;
try {
  const config = loadConfig(path);
  const db = join(dirname(config.databasePath), 'learning-display.sqlite');
  prepareDatabase(db);
  const authority = Object.freeze({});
  learning = new DisplayLearning({ databasePath: db, profileId: config.profileId, operatorAuthority: authority });
  let output;
  if (action === 'current') output = learning.current();
  else if (action === 'propose') {
    if (arg !== undefined || version !== undefined) throw new Error('candidate_must_use_stdin');
    const chunks = []; let size = 0;
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > 1024) throw new Error('candidate_too_large');
      chunks.push(chunk);
    }
    const candidate = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)).replace(/\r?\n$/, '');
    const proposal = learning.propose(candidate);
    output = { binding: displayBinding(proposal), state: proposal.state };
  }
  else {
    const n = Number(version);
    if (!arg || !Number.isSafeInteger(n) || n < 1) throw new Error('id_and_version_required');
    const proposal = learning.get(arg, n); const binding = displayBinding(proposal);
    if (action === 'show') output = { proposal, binding };
    else if (action === 'measure') { const measured = learning.measure(binding); output = { binding: displayBinding(measured), state: measured.state, measurement: measured.measurement }; }
    else if (['approve', 'reject', 'apply', 'revert'].includes(action)) {
      if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('interactive_terminal_required');
      console.log(JSON.stringify({ proposal, binding, action }, null, 2));
      const prompt = createInterface({ input: process.stdin, output: process.stdout });
      let answer;
      try { answer = await prompt.question(`Type ${action} ${arg} ${n} to confirm: `); } finally { prompt.close(); }
      if (answer !== `${action} ${arg} ${n}`) throw new Error('confirmation_declined');
      if (action === 'approve' || action === 'reject') output = learning.decide(binding, action, authority, 'confirmed locally');
      else if (action === 'apply') output = learning.apply(binding, authority);
      else output = learning.revert(binding, authority, 'confirmed locally');
    } else throw new Error('unknown_action');
  }
  console.log(JSON.stringify(output));
} catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
finally { learning?.close(); }
