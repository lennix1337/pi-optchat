import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseContract, type Action, type Contract, type Rule } from './autonomy.ts';

/**
 * Operator 03/11: the daily retro adjusts my own autonomy.json. What only he decides stays his: rules for these actions,
 * catch-all `*` rules and the default never change without him; every other rule may be added, edited or removed by me.
 */
export const PROTECTED_ACTIONS: readonly Action[] = ['force-push', 'deploy', 'production-write', 'paid', 'global-install', 'message', 'consent', 'merge-bypass', 'publish'];

const guarded = (rule: Rule) => rule.action === '*' || PROTECTED_ACTIONS.includes(rule.action);
const key = (rules: Rule[]) => JSON.stringify(rules.filter(guarded));

/** Why a change of the contract needs the operator; empty when I may make it myself. */
export function selfEditViolations(before: Contract, after: Contract): string[] {
  const problems: string[] = [];
  if (before.default !== after.default) problems.push(`default changes from ${before.default} to ${after.default}`);
  if (key(before.rules) !== key(after.rules)) problems.push(`rules for ${PROTECTED_ACTIONS.join(', ')} or * change (added, edited, removed or reordered)`);
  return problems;
}

const samePath = (a: string, b: string) => {
  const norm = (p: string) => resolve(p.replace(/^~(?=[\\/]|$)/, homedir())).replace(/\\/g, '/');
  return process.platform === 'win32' ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
};

type Edit = { oldText: string; newText: string };
const isEdit = (value: unknown): value is Edit => typeof value === 'object' && value !== null
  && typeof (value as Edit).oldText === 'string' && typeof (value as Edit).newText === 'string';

/** The file text an `edit`/`write` call would leave, or undefined when it cannot be known exactly. */
function resultingText(tool: string, input: Record<string, unknown>, current: string): string | undefined {
  if (tool === 'write') return typeof input.content === 'string' ? input.content : undefined;
  const edits = Array.isArray(input.edits) ? input.edits : isEdit(input) ? [input] : undefined;
  if (!edits?.length || !edits.every(isEdit)) return undefined;
  let text = current;
  for (const { oldText, newText } of edits) {
    const at = current.indexOf(oldText);
    if (!oldText || at < 0 || current.indexOf(oldText, at + 1) >= 0) return undefined;
    text = text.replace(oldText, () => newText);
  }
  return text;
}

export type SelfEdit = { ok: true; summary: string } | { ok: false; reason: string };

/**
 * Judges a call that would change the profile's autonomy.json: an `edit` or `write` of exactly that file whose result
 * parses and leaves the operator's protected rules untouched is mine to make (logged and reported). Anything else
 * (shell writes, other files, an unparseable result) is not judged here and still waits for him.
 */
export function judgeSelfEdit(dir: string | undefined, call: { tool: string; input: unknown }): SelfEdit | undefined {
  if (!dir || (call.tool !== 'edit' && call.tool !== 'write')) return undefined;
  const input = call.input as Record<string, unknown> | null;
  if (!input || typeof input.path !== 'string') return undefined;
  const file = join(dir, 'autonomy.json');
  if (!samePath(input.path, file)) return undefined;
  let current: string;
  try { current = readFileSync(file, 'utf8'); } catch { return { ok: false, reason: 'autonomy.json is unreadable now' }; }
  const text = resultingText(call.tool, input, current);
  if (text === undefined) return { ok: false, reason: 'the edit does not apply exactly once to the current file' };
  let before: Contract, after: Contract;
  try { before = parseContract(JSON.parse(current)); } catch (error) { return { ok: false, reason: `current autonomy.json is invalid (${String(error)})` }; }
  try { after = parseContract(JSON.parse(text)); } catch (error) { return { ok: false, reason: `the result would be invalid (${error instanceof Error ? error.message : String(error)})` }; }
  const problems = selfEditViolations(before, after);
  if (problems.length) return { ok: false, reason: problems.join('; ') };
  const added = after.rules.filter(r => !before.rules.some(b => JSON.stringify(b) === JSON.stringify(r)));
  const removed = before.rules.filter(r => !after.rules.some(a => JSON.stringify(a) === JSON.stringify(r)));
  const show = (r: Rule) => `${r.action} ${r.scope.join(',')} ${r.level}`;
  return { ok: true, summary: `autonomy.json self-edit: +[${added.map(show).join('; ')}] -[${removed.map(show).join('; ')}]` };
}
