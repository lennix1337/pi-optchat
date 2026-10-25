import { NODE } from './memory.ts';

/** Per-profile choices where OptChat departs from Victor's recipe. Each default is the recipe's behaviour unless noted. */
export const SETTINGS = {
  subagentLevels: { kind: 'number', label: 'Subagent levels', default: 1, min: 1, unit: '',
    description: 'How many levels of subagents. 1: only the main agent starts subagents. 2: those subagents may start their own, and so on.',
    applies: 'Applies to subagents started or resumed after this.' },
  maxAgents: { kind: 'number', label: 'Max active agents', default: 8, min: 1, unit: '',
    description: 'Subagents running at once in this profile, all levels together. It also caps how deep a chain can go.',
    applies: 'Applies to the next spawn.' },
  groupReports: { kind: 'toggle', label: 'Group subagent reports', default: false,
    description: 'Off: each subagent reports as soon as it finishes, as in Victor\'s recipe. On: the subagents started by one spawn report together, in one message once the last of them finishes.',
    applies: 'Applies to the next spawn.' },
  previousExchange: { kind: 'toggle', label: 'Previous exchange', default: false,
    description: 'Send your last request and its answer in full with the next turn, so a follow-up reads the exact wording. Off: memory view only, as in Victor\'s recipe, where nothing carries over between turns.',
    applies: 'Applies from the next turn.' },
  previousExchangeKB: { kind: 'number', label: 'Previous exchange limit', default: 16, min: 1, unit: 'KB',
    description: 'A larger last exchange, usually a big paste, is left out and the model zooms into memory instead.',
    applies: 'Applies from the next turn.' },
  memorySearch: { kind: 'toggle', label: 'Memory search', default: false,
    description: 'Give agents a search tool that finds original messages by plain text, newest first, for exact names, numbers, paths or errors the view doesn\'t show. Off: zoom and date only, as in Victor\'s recipe. Turning it on or off makes the next turn re-cache its prompt once.',
    applies: 'Applies from the next turn, and to subagents started or resumed after this.' },
  summaryAcceptBytes: { kind: 'number', label: 'Summary size tolerance', default: NODE, min: NODE, unit: 'bytes',
    description: `The compactor is always asked for ${NODE}-byte lines; a longer line up to this size is kept instead of retried. After five tries, the shortest complete line is kept if it is smaller than its source, even above this size; the view budgets its actual bytes. A higher value accepts longer lines immediately.`,
    applies: 'Applies to the next summary.' },
  syncStatus: { kind: 'toggle', label: 'Sync: status file', default: false,
    description: 'Keep ~/.optchat/status.md current with this chat: its oldest and newest memory lines and its operational state, so agents outside OptChat (Codex, Claude Code) can read what is going on. Written by code from memory, without a model, as the chat changes.',
    applies: 'Applies at once.' },
  syncOptMem: { kind: 'toggle', label: 'Sync: OptMem notes', default: false,
    description: 'Send each finished block of 64 messages to OptMem as `memo note` lines of at most 280 bytes, from the summary OptChat already built, so `memo recall` finds this chat\'s history. Starts at the newest finished block; a failed note is retried.',
    applies: 'Applies at once.' },
  syncAiMemory: { kind: 'toggle', label: 'Sync: ai-memory', default: false,
    description: 'Write this chat to the local ai-memory server (project `optchat`) as one page per finished block of 64 messages, with its block summary and every message\'s summary line, plus a status page after each block, so every agent\'s ai-memory search finds it. Starts at block 0, so turning it on imports the whole history; a failed write is retried.',
    applies: 'Applies at once.' },
  importJobs: { kind: 'number', label: 'Import: summaries at once', default: 8, min: 1, max: 64, unit: '',
    description: 'Summaries an import builds at once. With N at once, a summary can see up to N−1 lines not summarized yet before it, so higher is faster but a little less accurate (at 8 that costs about 0.8 points per summary, #108). Higher also hits your provider\'s rate limits harder; the compactor retries what is refused. Chat itself always runs 8.',
    applies: 'Applies to the next import.' },
  refreshAt: { kind: 'percent', label: 'Turn refresh threshold', default: 0.3, min: 0, max: 0.9,
    description: 'Once the current turn\'s messages pass this share of the model\'s context window, they move into memory and the turn goes on with a fresh window: the rebuilt view, the task word for word, and its last tool call and result. 0%: off, as in Victor\'s recipe, and a long turn can run out of window. OPTCHAT_REFRESH_AT (a fraction, e.g. 0.3; 0 is off) overrides it. Subagents use Pi\'s own compaction at about the same point.',
    applies: 'Applies from the next call, and to subagents started or resumed after this.' },
  refreshTokensK: { kind: 'number', label: 'Turn refresh cap', default: 0, min: 0, unit: 'K tokens',
    description: 'The most tokens the current turn may hold before it refreshes, whatever the window: with a 1M-token window, 30% lets a turn grow to 300K tokens, each call re-reading all of it. A refresh rewrites the cache once, so a lower cap trades one cache write for cheaper calls after it. 0: no cap, the threshold above alone. OPTCHAT_REFRESH_TOKENS (in tokens; 0 is no cap) overrides it. Main agent only.',
    applies: 'Applies from the next call.' },
  recoverableOutput: { kind: 'toggle', label: 'Recoverable shell output', default: true,
    description: 'Project large text-only shell results into a bounded preview for the model, with session-scoped originals and literal search. Original transcripts and operation evidence stay unchanged. Storage failures pass through the full result.',
    applies: 'Applies to the next request.' },
  focusedSubagents: { kind: 'toggle', label: 'Focused child history', default: false,
    description: 'Opt-in: new task agents receive at most 16 KiB of whole history lines, with older history available through zoom. Task, installed instructions and operational state remain exact; pass task-specific constraints explicitly. Connected conversations retain the full view.',
    applies: 'Applies to the next spawn.' },
  shellNotify: { kind: 'choice', label: 'Shell notices', default: 'end', options: { end: 'every end', failure: 'failures only', none: 'never' },
    description: 'What the main agent hears when a managed background shell ends: every end, only a failure (exit code or error), or never. A shell_start call can set its own notify. Alerts on a pattern (shell_start alert) are separate.',
    applies: 'Applies to shells started after this.' },
  heartbeatMinutes: { kind: 'number', label: 'Heartbeat', default: 0, min: 0, unit: 'min',
    description: 'Once the chat has sat idle this long, the compactor model (thinking off) reads the newest memory lines, the recorded state and how the last turn ended, and decides whether to wake the main agent for one more turn: a stalled task, unfinished work, or an open job from the `heartbeat` entry of config.json (jobs, allowed, never). The check only wakes; the main agent does the work. It repeats every interval while the chat stays idle. Interactive Pi only. 0: off.',
    applies: 'Applies when the chat next settles.' },
  heartbeatWakes: { kind: 'number', label: 'Heartbeat wakes per day', default: 6, min: 1, unit: '',
    description: 'The most main-agent turns the heartbeat may start in 24 hours; each one costs a full main-model turn. Checks that find nothing do not count.',
    applies: 'Applies to the next check.' },
} as const;

export type SettingKey = keyof typeof SETTINGS;
export type ShellNotify = keyof (typeof SETTINGS)['shellNotify']['options'];
export type Settings = { -readonly [K in SettingKey]: (typeof SETTINGS)[K] extends { kind: 'choice'; options: infer O } ? keyof O
  : (typeof SETTINGS)[K]['default'] extends boolean ? boolean : number };
export type NumberKey = { [K in SettingKey]: Settings[K] extends number ? K : never }[SettingKey];
export const SETTING_KEYS = Object.keys(SETTINGS) as SettingKey[];
export const isNumberKey = (key: SettingKey): key is NumberKey => SETTINGS[key].kind === 'number' || SETTINGS[key].kind === 'percent';
/** A percent setting is saved as a fraction of 1 and shown as a percentage. */
export const percent = (fraction: number) => `${Math.round(fraction * 1000) / 10}%`;

type Spec = (typeof SETTINGS)[SettingKey];
const choiceProblem = (spec: Extract<Spec, { kind: 'choice' }>, value: unknown) => typeof value === 'string' && Object.hasOwn(spec.options, value) ? undefined
  : `${spec.label} must be ${Object.keys(spec.options).join(', ')}.`;
const toggleProblem = (spec: Extract<Spec, { kind: 'toggle' }>, value: unknown) => typeof value === 'boolean' ? undefined : `${spec.label} must be true or false.`;
const percentProblem = (spec: Extract<Spec, { kind: 'percent' }>, value: unknown) => typeof value === 'number' && value >= spec.min && value <= spec.max ? undefined
  : `${spec.label} must be from ${percent(spec.min)} to ${percent(spec.max)}.`;
const numberProblem = (spec: Extract<Spec, { kind: 'number' }>, value: unknown) => {
  const { label, min, max = Infinity }: { label: string; min: number; max?: number } = spec;
  return Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max ? undefined
    : `${label} must be a whole number ${max === Infinity ? `of ${min} or more` : `from ${min} to ${max}`}.`;
};
/** Why a value can't be used, or undefined if it can. Numbers are whole and within their range. */
export function invalid(key: SettingKey, value: unknown) {
  const spec = SETTINGS[key];
  switch (spec.kind) {
    case 'choice': return choiceProblem(spec, value);
    case 'toggle': return toggleProblem(spec, value);
    case 'percent': return percentProblem(spec, value);
    case 'number': return numberProblem(spec, value);
  }
}

/** Missing keys take their defaults, so config files written before a setting existed keep working. */
export function readSettings(value: Record<string, unknown>): Settings {
  return Object.fromEntries(SETTING_KEYS.map(key => {
    const raw = Object.hasOwn(value, key) ? value[key] : SETTINGS[key].default, problem = invalid(key, raw);
    if (problem) throw new Error(problem);
    return [key, raw];
  })) as Settings;
}
export const DEFAULT_SETTINGS = readSettings({});
