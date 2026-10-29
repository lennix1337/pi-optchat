import { ToolEffects } from '../src/runtime/tool-effects.ts';
const path = process.argv[2], id = process.argv[3];
const effects = new ToolEffects(path, { prepare: () => ({ decision: 'review', reviewId: 'r' }), status: () => 'absent', ready: () => true,
  dispatch: async () => { process.stdout.write('CLAIMED\n'); setInterval(() => {}, 1000); await new Promise(() => {}); } }, () => true);
await effects.resume(id, { owner: 'owner', token: 1 });
