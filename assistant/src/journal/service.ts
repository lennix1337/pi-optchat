import type { NotificationChannel } from '../notifications/center.ts';
import { parseOutcomeInput, parseSignal } from '../contracts/signals.ts';
import { decideReflex } from './rules.ts';
import { SignalStore, type JournalDigest, type JournalMetrics, type OutcomePage, type Review, type SignalPage, type StoredSignal } from './store.ts';

export type SignalNotification = { id: string; channel: NotificationChannel; category: 'signal_attention' | 'signal_cleared'; ref: string };
export type SignalServiceOptions = {
  store: SignalStore;
  notify?: (notification: SignalNotification) => void;
  channels?: readonly NotificationChannel[];
  clock?: () => number;
};
export type IngestResult = {
  signal: StoredSignal;
  duplicate: boolean;
  decision: ReturnType<SignalStore['decide']> | null;
  notifications: number;
};

/**
 * The deterministic reflex path: ingest a signal, decide with fixed rules and, at most, enqueue a fixed-text
 * notification. It calls no model and dispatches no work; `turnsAvoided` only counts producers that declared they
 * suppressed a wake (`attention: 'wake'`).
 */
export class SignalService {
  private readonly store: SignalStore;
  private readonly notify: SignalServiceOptions['notify'];
  private readonly channels: readonly NotificationChannel[];
  private readonly clock: () => number;
  constructor(options: SignalServiceOptions) {
    this.store = options.store;
    this.notify = options.notify;
    this.channels = options.channels ?? ['web', 'local'];
    this.clock = options.clock ?? Date.now;
  }

  ingest(value: unknown): IngestResult {
    const parsed = parseSignal(value);
    const { signal, duplicate } = this.store.ingest(parsed);
    const existing = duplicate ? this.store.decision(signal.sequence) : null;
    if (existing) return { signal, duplicate: true, decision: existing, notifications: 0 };
    const now = this.clock();
    const rule = decideReflex(signal, {
      openIssue: this.store.openIssue(signal.subject) !== null,
      lastAttentionAt: this.store.lastAttention(signal.subject),
      now,
    });
    const decision = this.store.decide(signal, rule, now);
    let notifications = 0;
    if (this.notify && (decision.action === 'notify' || decision.action === 'resolve')) {
      const category = decision.action === 'notify' ? 'signal_attention' : 'signal_cleared';
      for (const channel of this.channels) {
        try { this.notify({ id: `signal-${signal.sequence}`, channel, category, ref: signal.signalId }); notifications++; }
        catch { /* The journal stays the source of truth; a refused notice is visible there. */ }
      }
    }
    return { signal, duplicate, decision, notifications };
  }

  signals(after = 0, limit = 50): SignalPage { return this.store.signals(after, limit); }
  metrics(from = 0, to = Number.MAX_SAFE_INTEGER): JournalMetrics { return this.store.metrics(from, to); }
  recordOutcome(value: unknown) {
    const input = parseOutcomeInput(value);
    return this.store.recordOutcome(input);
  }
  outcomes(after = 0, limit = 50): OutcomePage { return this.store.outcomes(after, limit); }
  review(now = this.clock()): Review { return this.store.review(now); }
  latestReview(): Review | null { return this.store.latestReview(); }
  digest(day?: string): JournalDigest { return this.store.digest(day); }
}
