import { createHash } from 'node:crypto';

const PLAN = /<proposed_plan>\s*([\s\S]*?)\s*<\/proposed_plan>/i;
const STEP = /^\s*(?:[-*]\s+\[([ xX])\]|\d+[.)])\s+(.*\S)\s*$/;
const SECTION_MAX = 3000;
const CARD_MAX = 12_000;
const TITLE_MAX = 80;

export const PLAN_IMPLEMENT = 'optchat_plan_implement';
export const PLAN_ADJUST = 'optchat_plan_adjust';
export const PLAN_ACTIONS: Readonly<Record<string, 'implement' | 'adjust'>> = { [PLAN_IMPLEMENT]: 'implement', [PLAN_ADJUST]: 'adjust' };
/** The button value: which plan the tap is about, so it answers that plan only. */
export const PLAN_VALUE = /^plano:([0-9a-f]{8}):([^\n\r]{1,80})$/;

export type Plan = { before: string; plan: string; after: string };

/** The first plan in a message and the text around it, or undefined. */
export function extractPlan(text: string): Plan | undefined {
  const match = PLAN.exec(text);
  if (!match?.[1]) return undefined;
  return { before: text.slice(0, match.index).trim(), plan: match[1], after: text.slice(match.index + match[0].length).trim() };
}

/** The message with the plan's tags removed, for a post that cannot carry a card. */
export const withoutPlanTags = (text: string): string => text.replace(/<\/?proposed_plan>/gi, '');

const plain = (line: string) => line.replace(/^[\s#>*_-]+/, '').replace(/^\[[ xX]\]\s*/, '').replace(/^\d+[.)]\s+/, '').replace(/[*_`~]/g, '').replace(/<([^|>]+)\|([^>]+)>/g, '$2').trim();

export function planTitle(plan: string): string {
  const line = plan.split('\n').map(plain).find(Boolean) ?? 'Plano';
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line;
}

/** Eight hex digits that name this plan text. */
export const planId = (plan: string): string => createHash('sha256').update(plan).digest('hex').slice(0, 8);

/** Each step of the plan (checkbox or numbered line), and whether its own checkbox is already ticked. */
export function planSteps(plan: string): { text: string; ticked: boolean }[] {
  return plan.split('\n').flatMap(line => { const m = STEP.exec(line); return m ? [{ text: m[2]!, ticked: m[1] === 'x' || m[1] === 'X' }] : []; });
}

export const canCard = (plan: Plan): boolean => plan.plan.length <= CARD_MAX;

function body(plan: string): string {
  const total = planSteps(plan).length;
  const finished = new Set<number>();
  let index = 0;
  const lines = plan.split('\n').map(line => {
    const m = STEP.exec(line);
    if (!m) return line;
    const step = index++;
    if (m[1] === 'x' || m[1] === 'X') finished.add(step);
    return `\u0000${step}\u0000${m[2]}`;
  });
  const current = [...Array(total).keys()].find(i => !finished.has(i));
  return lines.map(line => {
    const m = /^\u0000(\d+)\u0000(.*)$/.exec(line);
    if (!m) return line.replace(/^#{1,6}\s+(.+)$/, '*$1*').replace(/\*\*(.+?)\*\*/g, '*$1*').replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<$2|$1>');
    const step = Number(m[1]);
    return finished.has(step) ? `\u2714 ~${m[2]}~` : step === current && finished.size > 0 ? `\u25b6\ufe0f *${m[2]}*` : `\u2b1c ${m[2]}`;
  }).join('\n');
}

/** How many steps are done: the ones whose checkbox is ticked in the plan text. */
export function planProgress(plan: string): { done: number; total: number } {
  const steps = planSteps(plan);
  return { done: steps.filter(s => s.ticked).length, total: steps.length };
}

function sections(text: string): unknown[] {
  const out: unknown[] = [];
  let current = '';
  for (const line of text.split('\n')) {
    let rest = line;
    while (rest.length > SECTION_MAX) { if (current) { out.push(current); current = ''; } out.push(rest.slice(0, SECTION_MAX)); rest = rest.slice(SECTION_MAX); }
    const next = current ? `${current}\n${rest}` : rest;
    if (next.length > SECTION_MAX) { out.push(current); current = rest; } else current = next;
  }
  if (current.trim()) out.push(current);
  return out.map(value => ({ type: 'section', text: { type: 'mrkdwn', text: value } }));
}

/** The notification line (what the phone shows before the card opens): the plan's subject and its progress. */
export function planPreview(plan: string): string {
  const { done, total } = planProgress(plan);
  return `Plano proposto: ${planTitle(plan)}${total ? ` \u00b7 ${done}/${total}` : ''}`.slice(0, 120);
}

/** The card. In the DM it carries the two buttons until the first step is ticked; then the progress replaces them. */
export function planBlocks(parts: Plan, options: { actions: boolean }): unknown[] {
  const progress = planProgress(parts.plan);
  const button = (action_id: string, label: string, value: string, style?: string) => ({ type: 'button', action_id, value, text: { type: 'plain_text', text: label }, ...(style ? { style } : {}) });
  const value = `plano:${planId(parts.plan)}:${planTitle(parts.plan)}`;
  return [
    { type: 'header', text: { type: 'plain_text', text: `Plano proposto${progress.total ? ` \u00b7 ${progress.done}/${progress.total}` : ''}` } },
    ...parts.before ? sections(parts.before) : [],
    ...sections(body(parts.plan)),
    ...parts.after ? sections(parts.after) : [],
    ...options.actions && progress.done === 0 ? [{ type: 'actions', elements: [button(PLAN_IMPLEMENT, 'Implementar', value, 'primary'), button(PLAN_ADJUST, 'Ajustar plano', value)] }] : [],
  ].slice(0, 50);
}

/** The card's blocks after a tap: the plan stays, the buttons give way to a line saying what the operator chose. */
export function settledPlanBlocks(blocks: unknown, chosen: string): unknown[] {
  const kept = Array.isArray(blocks) ? blocks.filter(b => b && typeof b === 'object' && (b as { type?: unknown }).type !== 'actions') : [];
  return [...kept, { type: 'context', elements: [{ type: 'mrkdwn', text: `\u2192 Você tocou em *${chosen}*; o resultado vem nesta thread.` }] }].slice(0, 50);
}
