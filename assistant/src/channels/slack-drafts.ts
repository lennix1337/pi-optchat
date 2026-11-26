import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { DraftSink, GoogleConnections, MessageDraft } from '../connectors/google.ts';
import type { WriteContext } from '../connectors/mcp.ts';
import type { Gateway } from '../policy/gateway.ts';
import type { Outcome } from './inbound.ts';
import type { DraftAction, SlackPoster } from './slack-relay.ts';

export type DraftReviewOptions = {
  google: Pick<GoogleConnections, 'prepareSend' | 'send'>; gateway: Pick<Gateway, 'decide' | 'revoke'>; authority: object;
  poster: SlackPoster; sink: DraftSink<unknown>; feedbackPath: string;
  ttlMs?: number; now?: () => number; log: (message: string) => void;
};

type Write = Omit<WriteContext, 'operationId' | 'expiresAt'>;
type Post = { channel: string; ts: string };
type Entry = {
  reviewId: string; write: WriteContext; timer: NodeJS.Timeout;
  draft?: MessageDraft; post?: Post; state: 'pending' | 'edit' | 'reason';
};
const DEFAULT_TTL_MS = 15 * 60_000;
const DRAFT_LIMIT = 32;

export class SlackDraftReviews {
  private readonly options: DraftReviewOptions;
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly entries = new Map<string, Entry>();
  private closed = false;

  constructor(options: DraftReviewOptions) {
    const ttl = options.ttlMs ?? DEFAULT_TTL_MS;
    if (!Number.isSafeInteger(ttl) || ttl < 1_000 || ttl > 24 * 60 * 60_000) throw new Error('invalid_draft_ttl');
    this.options = options;
    this.now = options.now ?? Date.now;
    this.ttlMs = ttl;
    this.db = new DatabaseSync(options.feedbackPath);
    this.db.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS slack_draft_feedback (id TEXT PRIMARY KEY, reason TEXT NOT NULL, recorded_at INTEGER NOT NULL)');
  }

  async prepare(input: MessageDraft, context: Write): Promise<string> {
    if (this.closed || this.entries.size >= DRAFT_LIMIT) throw new Error('draft_review_unavailable');
    if (input.kind !== 'message') throw new Error('invalid_draft');
    const draft = { ...input, to: [...input.to] };
    const id = randomUUID();
    const write = { ...context, operationId: id, expiresAt: this.now() + this.ttlMs };
    const { google, poster } = this.options;
    const review = google.prepareSend(draft, write);
    if (review.decision !== 'review') throw new Error('draft_review_required');
    const timer = setTimeout(() => this.expire(id), this.ttlMs).unref();
    const entry: Entry = { reviewId: review.reviewId, draft, write, timer, state: 'pending' };
    this.entries.set(id, entry);
    try {
      const { body, subject } = JSON.parse(Buffer.from(review.payload).toString('utf8')) as { body: string; subject: string };
      entry.post = await poster.postDraftReview(id, `De: ${review.metadata.account}\nPara: ${review.metadata.destination}\nAssunto: ${subject}\n\n${body}`, write.expiresAt);
    } catch (error) {
      if (this.entries.get(id) === entry) this.forget(id, entry, true);
      throw error;
    }
    if (this.entries.get(id) !== entry || write.expiresAt <= this.now()) {
      if (this.entries.get(id) === entry) this.forget(id, entry, true);
      this.update(entry.post, 'Rascunho indisponível. Não foi enviado.');
      throw new Error('draft_review_unavailable');
    }
    return id;
  }

  tap(user: string, post: Post, id: string, action: DraftAction): Outcome {
    if (user !== this.options.poster.operator) return 'unauthorized_sender';
    const entry = this.entries.get(id);
    if (!entry || entry.state !== 'pending' || entry.post?.channel !== post.channel || entry.post.ts !== post.ts) return 'stale';
    if (entry.write.expiresAt <= this.now()) { this.expire(id); return 'stale'; }
    if (action === 'approve') {
      const draft = entry.draft!;
      this.forget(id, entry, false);
      void this.send(draft, entry.write, entry.reviewId, post);
    } else {
      entry.state = action === 'edit' ? 'edit' : 'reason';
      if (action === 'discard') delete entry.draft;
      this.revoke(entry.reviewId);
      this.update(post, action === 'edit' ? 'Rascunho em edição. Responda nesta thread com o novo corpo do e-mail para gerar outro rascunho.' : 'Rascunho descartado. Responda nesta thread com o motivo.');
    }
    return 'responded';
  }

  reply(user: string, post: Post, text: string): Outcome | undefined {
    if (user !== this.options.poster.operator) return undefined;
    for (const [id, entry] of this.entries) {
      if (entry.post?.channel !== post.channel || entry.post.ts !== post.ts) continue;
      if (entry.write.expiresAt <= this.now()) { this.expire(id); return 'stale'; }
      if (entry.state === 'pending') return 'review_required';
      if (!text.trim() || !text.isWellFormed() || text.length > (entry.state === 'reason' ? 2_000 : 30_000)) return 'ignored';
      if (entry.state === 'reason') {
        this.db.prepare('INSERT INTO slack_draft_feedback VALUES (?, ?, ?)').run(id, text.trim(), this.now());
        this.forget(id, entry, false);
        this.update(post, 'Rascunho descartado. Motivo registrado.');
      } else {
        const draft = { ...entry.draft!, body: text };
        this.forget(id, entry, false);
        void this.prepare(draft, entry.write).then(
          () => this.update(post, 'Rascunho anterior cancelado. Revise a nova versão no DM.'),
          () => this.update(post, 'Não foi possível preparar a nova versão. Nenhum e-mail enviado.'),
        );
      }
      return 'responded';
    }
    return undefined;
  }

  feedback(id: string): string | undefined {
    const row = this.db.prepare('SELECT reason FROM slack_draft_feedback WHERE id = ?').get(id);
    return row?.reason as string | undefined;
  }

  close(): void {
    this.closed = true;
    for (const [id, entry] of this.entries) this.forget(id, entry, entry.state === 'pending');
    this.db.close();
  }

  private async send(draft: MessageDraft, write: WriteContext, reviewId: string, post: Post): Promise<void> {
    const { google, gateway, authority, sink } = this.options;
    try {
      gateway.decide(reviewId, 'approve', authority);
      await google.send(draft, write, sink, reviewId);
    } catch (error) {
      this.revoke(reviewId);
      this.update(post, error instanceof Error && error.message === 'effect_uncertain' ? 'Envio não confirmado. Verifique antes de tentar novamente.' : 'O envio não foi concluído.');
      return;
    }
    this.update(post, 'E-mail enviado.');
  }

  private expire(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.forget(id, entry, entry.state === 'pending');
    if (entry.post && entry.state === 'pending') this.update(entry.post, 'Rascunho expirado. Não foi enviado.');
  }

  private forget(id: string, entry: Entry, revoke: boolean): void {
    this.entries.delete(id);
    clearTimeout(entry.timer);
    if (revoke) this.revoke(entry.reviewId);
  }

  private revoke(reviewId: string): void {
    try { this.options.gateway.revoke(reviewId, this.options.authority); }
    catch { this.options.log('Draft review could not be revoked.'); }
  }

  private update(post: Post, text: string): void {
    void this.options.poster.update(post.channel, post.ts, text).catch(() => this.options.log('Draft review card could not be updated.'));
  }
}
