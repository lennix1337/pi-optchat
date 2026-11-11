import type { WorkerKind } from './crew.ts';

/** What a contract worker (a spawn with a `kind`) carries on every request. A worker never delegates, browses, runs the operator's desktop or
 *  holds credentials, so its tool declarations and prompt leave out what the manager needs and the worker has never used. */
const BASE = ['bash', 'read', 'edit', 'write', 'output_read', 'shell_start', 'shell_status', 'tell_parent', 'tell_peer', 'specialist_memory'];
const CODE = [...BASE, 'shell_stop', 'operation_state', 'project_checks', 'project_evidence', 'zoom', 'ripwire'];
const WEB = ['web_enable', 'web_search', 'source_check', 'fetch_content', 'get_search_content'];
const HARD = [...CODE, 'lsp', 'codemode', ...WEB];

/** Tool names a worker may use, by kind (Pi's `tools` allowlist: everything else stays unregistered). A plain subagent has no kind and no list. */
/** A specialist patrol only reads: no edit or write, and bash is filtered to reads (patrol.ts). Its commitments tool is limited to its own project. */
export const PATROL_TOOLS: readonly string[] = ['bash', 'read', 'output_read', 'project_evidence', 'specialist_memory', 'commitments'];
export const WORKER_TOOLS: Record<WorkerKind, readonly string[]> = {
  code: CODE,
  mechanical: BASE.filter(name => name !== 'specialist_memory'),
  plan: HARD,
  hard: HARD,
};

/** The profile instructions' `## ` sections a worker keeps, by heading name (a heading's parenthesised dating note is ignored); the text before the first heading stays. */
export const WORKER_SECTIONS = ['Global rules', 'Authority', 'Talking to the operator', 'Code changes'] as const;

const heading = (line: string) => /^## (.*?)\s*(?:\(.*\))?\s*$/.exec(line)?.[1];

/** The profile's instructions cut to `WORKER_SECTIONS`: no wakes, Slack, deploys, retro, delegation or compaction rules. */
export function leanProfile(text: string) {
  const kept: string[] = [];
  let keep = true;
  for (const line of text.split('\n')) {
    const name = line.startsWith('## ') ? heading(line) ?? line.slice(3).trim() : undefined;
    if (name !== undefined) keep = (WORKER_SECTIONS as readonly string[]).includes(name);
    if (keep) kept.push(line);
  }
  return kept.join('\n').trimEnd();
}

/** Skills a worker lists: code navigation and checking, not the whole catalog. */
const SKILLS = new Set(['local-validation', 'systematic-debugging', 'verification-before-completion', 'writing-for-agents']);
export const leanSkill = (name: string) => name.startsWith('ripwire-') || SKILLS.has(name);

export const WORKER = `You are a worker of OptChat, an AI agent that works for one user. OptChat gave you a contract: your first message holds your project's brief and
the contract (Goal, Acceptance, Evidence, Authority). Do it yourself, with your tools, following the user's instructions at the end of this prompt: they say who
the user is, how their files are organized and how they want work done. Stay inside the contract's authority. Your final reply is your report to OptChat.
OptChat may send you more messages, even while you work. zoom opens OptChat's memory read-only: use it only for an id your contract cites.

Be aware of time. When your task is long, tell OptChat how far you are with tell_parent. Before you wait on something slow, such as CI, say so the same
way ("pushed, now watching CI until it passes"), so OptChat can go on without you, then watch it.`;

/** The system prompt's working-directory section for a contract worker. The directory differs per worktree and sits before the profile's
 *  instructions, so naming it there made every worker's prompt differ from there on; the first message carries it instead. */
export const WORKER_CWD = 'Your working directory is the "Working directory" line of your first message.';
