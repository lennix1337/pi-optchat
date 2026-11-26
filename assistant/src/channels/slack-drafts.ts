import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { DraftSink, GoogleConnections, MessageDraft } from '../connectors/google.ts';
import type { WriteContext } from '../connectors/mcp.ts';
import type { Gateway } from '../policy/gateway.ts';
import type { Outcome } from './inbound.ts';
import type { DraftAction, SlackPoster } from './slack-relay.ts';

export type DraftReviewOptions = {
  google: Pick<GoogleConnections, 'prepareSend' | 'send'>; gateway: Pick<Gateway, 'decide' | 'revoke' | 'status'>; authority: object;
  poster: SlackPoster; sink: DraftSink<unknown>; feedbackPath: string;
  ttlMs?: number; now?: () => number; log: (message: string) => void;
};

type Write = Omit<WriteContext, 'operationId' | 'expiresAt'>;
type Post = { channel: string; ts: string };
type Entry = {
  reviewId: string; write: WriteContext; timer: NodeJS.Timeout;
  draft?: MessageDraft; post?: Post; replacement?: string;
  state: 'pending' | 'sending' | 'edit' | 'replacing' | 'reason';
};
const DEFAULT_TTL_MS = 15 * 60_000;
const DRAFT_LIMIT = 32;

async function dispatchDraft({ google, gateway, authority, sink, log }: DraftReviewOptions, { draft, write, reviewId }: Entry) {
  try {
    gateway.decide(reviewId, 'approve', authority);
    await google.send(draft!, write, sink, reviewId);
    return 'sent';
  } catch (error) {
    try {
      gateway.revoke(reviewId, authority);
      const noDispatchIntent = gateway.status(write.operationId) === 'absent';
      if (noDispatchIntent && !(error instanceof Error && error.message === 'effect_uncertain')) return 'not_sent';
    } catch { log('Draft send status could not be verified.'); }
    return 'uncertain';
  }
}

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

  prepare(input: MessageDraft, context: Write): Promise<string> {
    return this.stage(input, context, this.now() + this.ttlMs);
  }

  private async stage(input: MessageDraft, context: Write, expiresAt: number, previous?: Entry): Promise<string> {
    if (this.closed || this.entries.size >= DRAFT_LIMIT || expiresAt <= this.now()) throw new Error('draft_review_unavailable');
    if (input.kind !== 'message') throw new Error('invalid_draft');
    const draft = { ...input, to: [...input.to] };
    const id = randomUUID();
    const write = { ...context, operationId: id, expiresAt };
    const { google, poster } = this.options;
    const review = google.prepareSend(draft, write);
    if (review.decision !== 'review') throw new Error('draft_review_required');
    const timer = setTimeout(() => this.expire(id), expiresAt - this.now()).unref();
    const entry: Entry = { reviewId: review.reviewId, draft, write, timer, state: 'replacing' };
    this.entries.set(id, entry);
    try {
      const { body, subject } = JSON.parse(Buffer.from(review.payload).toString('utf8')) as { body: string; subject: string };
      entry.post = await poster.postDraftReview(id, `De: ${review.metadata.account}\nPara: ${review.metadata.destination}\nAssunto: ${subject}\n\n${body}`, expiresAt);
      if (this.entries.get(id) !== entry || expiresAt <= this.now()) throw new Error('draft_review_unavailable');
      if (previous) {
        this.options.gateway.revoke(previous.reviewId, this.options.authority);
        this.forget(previous.write.operationId, previous, false);
      }
      entry.state = 'pending';
      return id;
    } catch (error) {
      if (this.entries.get(id) === entry) this.forget(id, entry, true);
      if (entry.post) this.update(entry.post, 'Rascunho indisponível. Não foi enviado.');
      throw error;
    }
  }

  tap(user: string, post: Post, id: string, action: DraftAction): Outcome {
    if (user !== this.options.poster.operator) return 'unauthorized_sender';
    const entry = this.entries.get(id);
    if (!entry || entry.post?.channel !== post.channel || entry.post.ts !== post.ts) return 'stale';
    if (entry.write.expiresAt <= this.now()) { this.expire(id); return 'stale'; }
    if (action === 'edit' && entry.state === 'edit' && entry.replacement !== undefined) {
      void this.replace(id, entry, post);
      return 'responded';
    }
    if (entry.state !== 'pending') return 'stale';
    if (action === 'approve') {
      entry.state = 'sending';
      void this.send(id, entry, post);
    } else if (action === 'edit') {
      entry.state = 'edit';
      this.update(post, 'Rascunho em edição. Responda nesta thread com o novo corpo do e-mail para gerar outro cartão.', true);
    } else {
      entry.state = 'reason';
      delete entry.draft;
      this.revoke(entry.reviewId);
      this.update(post, 'Rascunho descartado. Responda nesta thread com o motivo.');
    }
    return 'responded';
  }

  reply(user: string, post: Post, text: string): Outcome | undefined {
    if (user !== this.options.poster.operator) return undefined;
    for (const [id, entry] of this.entries) {
      if (entry.post?.channel !== post.channel || entry.post.ts !== post.ts) continue;
      if (entry.write.expiresAt <= this.now()) { this.expire(id); return 'stale'; }
      if (entry.state !== 'edit' && entry.state !== 'reason') return 'review_required';
      if (!text.trim() || !text.isWellFormed() || text.length > (entry.state === 'reason' ? 2_000 : 30_000)) return 'ignored';
      if (entry.state === 'reason') {
        this.db.prepare('INSERT INTO slack_draft_feedback VALUES (?, ?, ?)').run(id, text.trim(), this.now());
        this.forget(id, entry, false);
        this.update(post, 'Rascunho descartado. Motivo registrado.');
      } else {
        entry.replacement = text;
        void this.replace(id, entry, post);
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
    for (const [id, entry] of this.entries) this.forget(id, entry, entry.state !== 'reason');
    this.db.close();
  }

  private async send(id: string, entry: Entry, post: Post): Promise<void> {
    const outcome = await dispatchDraft(this.options, entry);
    if (this.entries.get(id) !== entry) return;
    if (outcome === 'not_sent' && entry.write.expiresAt > this.now()) {
      entry.state = 'edit';
      entry.replacement = entry.draft!.body;
      this.update(post, 'O e-mail não foi enviado. Toque em Editar para criar outro cartão com o mesmo texto, ou responda nesta thread com outro texto. O novo cartão precisa de aprovação.', true);
      return;
    }
    this.forget(id, entry, false);
    this.update(post, {
      sent: 'E-mail enviado.',
      not_sent: 'O e-mail não foi enviado. O rascunho expirou.',
      uncertain: 'Envio não confirmado. Confira a pasta Enviados do Gmail; não reenvie enquanto o resultado estiver incerto.',
    }[outcome]);
  }

  private async replace(id: string, entry: Entry, post: Post): Promise<void> {
    entry.state = 'replacing';
    try {
      await this.stage({ ...entry.draft!, body: entry.replacement! }, entry.write, entry.write.expiresAt, entry);
      this.update(post, 'Rascunho anterior cancelado. Revise a nova versão no DM.');
    } catch {
      if (this.entries.get(id) !== entry) return;
      if (entry.write.expiresAt <= this.now()) { this.expire(id); return; }
      entry.state = 'edit';
      this.update(post, 'Não foi possível criar o novo cartão. O texto foi mantido: toque em Editar para usar o mesmo texto ou responda nesta thread com outro.', true);
    }
  }

  private expire(id: string): void {
    const entry = this.entries.get(id);
    if (!entry || entry.state === 'sending') return;
    this.forget(id, entry, entry.state !== 'reason');
    if (entry.post && entry.state !== 'reason') this.update(entry.post, 'Rascunho expirado. Não foi enviado.');
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

  private update(post: Post, text: string, thread = false): void {
    const { poster, log } = this.options;
    const delivery = thread ? poster.replyToDraftReview(post, text) : poster.update(post.channel, post.ts, text);
    void delivery.catch(() => log('Draft review Slack message could not be updated.'));
  }
}
