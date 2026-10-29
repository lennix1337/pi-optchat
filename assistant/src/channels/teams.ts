import { createPublicKey, verify } from 'node:crypto';
import type { TaskStore } from '../store/db.ts';
import { admit, type ChannelLedger, type Received } from './inbound.ts';

export type Jwk = { kty: string; n: string; e: string; kid: string; endorsements?: string[] };
const ISSUER = 'https://api.botframework.com';
const SKEW_SECONDS = 300;
const part = (value: string) => JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));

/**
 * Bot Framework bearer token: RS256 by a published key endorsed for msteams, issuer, audience = this app,
 * lifetime with 5 min skew, and the activity's serviceUrl must equal the token's claim. Keys are supplied by the
 * caller (fetched from the published OpenID metadata outside this module), so tests run offline.
 */
export function verifyTeams(authorization: string, options: { appId: string; keys: readonly Jwk[]; now: number; serviceUrl: string }): boolean {
  const match = /^Bearer ([\w-]+)\.([\w-]+)\.([\w-]+)$/.exec(authorization);
  if (!match) return false;
  try {
    const head = part(match[1]); const claims = part(match[2]);
    if (head.alg !== 'RS256' || typeof head.kid !== 'string') return false;
    const key = options.keys.find(candidate => candidate.kid === head.kid && (!candidate.endorsements || candidate.endorsements.includes('msteams')));
    if (!key) return false;
    const ok = verify('RSA-SHA256', Buffer.from(`${match[1]}.${match[2]}`), createPublicKey({ key: { kty: key.kty, n: key.n, e: key.e }, format: 'jwk' }), Buffer.from(match[3], 'base64url'));
    if (!ok) return false;
    const now = options.now / 1000;
    return claims.iss === ISSUER && claims.aud === options.appId && typeof claims.exp === 'number' && now <= claims.exp + SKEW_SECONDS
      && (claims.nbf === undefined || now >= claims.nbf - SKEW_SECONDS) && claims.serviceurl === options.serviceUrl;
  } catch { return false; }
}

export type TeamsOptions = {
  store: TaskStore; ledger: ChannelLedger; profileId: string; appId: string; tenantId: string; keys: () => readonly Jwk[];
  now?: () => number; reviewLink: (taskId: string) => string;
};

export class TeamsChannel {
  private readonly options: TeamsOptions & { now: () => number };
  constructor(options: TeamsOptions) { this.options = { now: Date.now, ...options }; }
  receive(authorization: string, rawBody: string): Received {
    const o = this.options;
    let activity: Record<string, any>;
    try { activity = JSON.parse(rawBody); } catch { return { outcome: 'unauthenticated' }; }
    if (typeof activity?.serviceUrl !== 'string' || !verifyTeams(authorization, { appId: o.appId, keys: o.keys(), now: o.now(), serviceUrl: activity.serviceUrl })) return { outcome: 'unauthenticated' };
    if (activity.channelData?.tenant?.id !== o.tenantId || (activity.conversation?.tenantId !== undefined && activity.conversation.tenantId !== o.tenantId)) return { outcome: 'foreign_workspace' };
    if (activity.type === 'invoke') {
      // Adaptive card "approve" actions are remote clicks; the exact effect is reviewed in the authenticated panel.
      const taskId = typeof activity.value?.taskId === 'string' ? activity.value.taskId : '';
      return { outcome: 'review_required', reply: `Revise no painel autenticado: ${o.reviewLink(taskId)}` };
    }
    if (activity.type !== 'message' || typeof activity.id !== 'string' || typeof activity.conversation?.id !== 'string') return { outcome: 'ignored' };
    const sender = typeof activity.from?.aadObjectId === 'string' ? activity.from.aadObjectId : '';
    return admit({
      platform: 'teams', account: o.tenantId, delivery: activity.id, sender, human: activity.from?.role !== 'bot' && Boolean(sender),
      conversation: activity.conversation.id, messageId: activity.id, ...(typeof activity.replyToId === 'string' ? { thread: activity.replyToId } : {}),
      text: typeof activity.text === 'string' ? activity.text : '',
    }, o);
  }
}
