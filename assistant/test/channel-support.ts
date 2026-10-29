import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { TaskStore } from '../src/store/db.ts';
import { ChannelLedger } from '../src/channels/inbound.ts';
import type { Event } from '../src/contracts/events.ts';

export const PROFILE = 'channel-test';
/** A Slack Events API envelope for team T0TEST / app A0TEST carrying one DM from U0OWNER. */
export function slackEnvelope(eventId: string, text: string, eventOver: Record<string, unknown> = {}, envelopeOver: Record<string, unknown> = {}) {
  return {
    type: 'event_callback', team_id: 'T0TEST', api_app_id: 'A0TEST', event_id: eventId,
    event: { type: 'message', channel: 'D0OWNER', user: 'U0OWNER', text, ts: '1793000000.000100', ...eventOver }, ...envelopeOver,
  };
}
export function channelFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'assistant-channels-'));
  const authority = {};
  const storePath = join(dir, 'tasks.sqlite'); const ledgerPath = join(dir, 'channels.sqlite');
  let store = new TaskStore(storePath, PROFILE);
  let ledger = new ChannelLedger({ databasePath: ledgerPath, profileId: PROFILE, operatorAuthority: authority });
  return {
    dir, authority,
    get store() { return store; }, get ledger() { return ledger; },
    reopen() { store.close(); ledger.close(); store = new TaskStore(storePath, PROFILE); ledger = new ChannelLedger({ databasePath: ledgerPath, profileId: PROFILE, operatorAuthority: authority }); },
    /** The worker asks a new question on a task that is working again. */
    askAgain(taskId: string) {
      const task = store.get(taskId)!;
      return store.transition(taskId, task.revision, 'needs_input', { version: 1, eventId: randomUUID(), profileId: PROFILE, taskId, sessionId: 'worker', channelId: 'local', runId: 'run', source: { actorId: 'worker', sourceKind: 'worker', sourceEventId: randomUUID() }, observedAt: new Date().toISOString(), sequence: store.nextSequence(), correlationId: randomUUID(), evidence: { kind: 'observed', reference: 'fixture://worker' } });
    },
    /** A task the local worker put in needs_input, as the outbound notifier would see it. */
    needsInput(title = 'Escolher fornecedor') {
      const id = randomUUID();
      const event = (): Event => ({ version: 1, eventId: randomUUID(), profileId: PROFILE, taskId: id, sessionId: 'worker', channelId: 'local', runId: 'run', source: { actorId: 'worker', sourceKind: 'worker', sourceEventId: randomUUID() }, observedAt: new Date().toISOString(), sequence: store.nextSequence(), correlationId: randomUUID(), evidence: { kind: 'observed', reference: 'fixture://worker' } });
      const first = event();
      store.create({ version: 1, profileId: PROFILE, taskId: id, title, status: 'queued', verification: 'not_verified', revision: 1, inputRevision: 1, sourceEventId: first.source.sourceEventId }, first);
      store.transition(id, 1, 'working', event());
      return store.transition(id, 2, 'needs_input', event());
    },
    close() { store.close(); ledger.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}
