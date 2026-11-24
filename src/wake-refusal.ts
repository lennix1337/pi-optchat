import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWrite } from './store.ts';

const FILE = 'wake-suppressions.json', WEEK = 7 * 86_400_000;
type Post = { channel: string; thread: string; topic: string; at: number };
export type WakeRefusal = { text: string; origin: 'slack'; channel: string; ts: string; createdAt: number; expiresAt: number; topic: string };
type State = { posts: Post[]; rules: WakeRefusal[] };

function read(dir: string): State {
  try {
    const state = JSON.parse(readFileSync(join(dir, FILE), 'utf8')) as State;
    if (!Array.isArray(state.posts) || !Array.isArray(state.rules)) throw new Error('invalid wake suppression state');
    return state;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { posts: [], rules: [] };
    throw error;
  }
}
function save(dir: string, state: State) { atomicWrite(join(dir, FILE), JSON.stringify(state)); }

/** Only a top-level post can be identified unambiguously by Slack's thread_ts. */
export function rememberWake(dir: string, channel: string, thread: string, topic: string, now: number): void {
  if (!channel || !thread || !topic.trim()) return;
  const state = read(dir);
  state.posts = [...state.posts.filter(p => now - p.at < WEEK && !(p.channel === channel && p.thread === thread)), { channel, thread, topic, at: now }];
  save(dir, state);
}

/** A reply is attributable only to the direct, authorized Slack event and to a known wake thread. */
export function recordRefusal(dir: string, channel: string, thread: string, input: { text: string; ts: string }, now: number): boolean {
  if (!/^\s*(?:n[aã]o(?:\s+(?:quero|precisa))?|para\s+de)(?=$|[\s,;.!?])/i.test(input.text)) return false;
  const state = read(dir), post = state.posts.find(p => p.channel === channel && p.thread === thread && now - p.at < WEEK);
  if (!post || state.rules.some(r => r.origin === 'slack' && r.channel === channel && r.ts === input.ts)) return false;
  state.rules = [...state.rules.filter(r => r.expiresAt > now), { text: input.text, origin: 'slack', channel, ts: input.ts, createdAt: now, expiresAt: now + WEEK, topic: post.topic }];
  save(dir, state);
  return true;
}

export function activeRefusals(dir: string, now: number): WakeRefusal[] { return read(dir).rules.filter(rule => rule.expiresAt > now); }

export function revokeRefusal(dir: string, id: string): boolean {
  const state = read(dir), remaining = state.rules.filter(rule => `${rule.channel}:${rule.ts}` !== id);
  if (remaining.length === state.rules.length) return false;
  save(dir, { ...state, rules: remaining });
  return true;
}

const STOP = new Set(['para', 'com', 'uma', 'por', 'que', 'dos', 'das', 'projeto', 'sobre', 'verificar', 'revisar', 'analisar']);
function terms(text: string): Set<string> {
  return new Set((text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().match(/[a-z0-9]{4,}/g) ?? []).filter(t => !STOP.has(t)));
}
/** Require two significant common words and a substantial overlap: a single generic word must not mute unrelated work. */
export function suppressedWake(dir: string, candidate: string, now: number): WakeRefusal | undefined {
  const words = terms(candidate), exact = candidate.trim().toLocaleLowerCase();
  if (!exact) return undefined;
  return read(dir).rules.find(rule => {
    if (rule.expiresAt <= now) return false;
    if (exact === rule.topic.trim().toLocaleLowerCase()) return true;
    const topic = terms(rule.topic), common = [...topic].filter(word => words.has(word)).length;
    return common >= 2 && common / topic.size >= 0.75 && common / words.size >= 0.5;
  });
}
