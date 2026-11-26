import type { MailMessage } from '../connectors/google.ts';

/**
 * Bills to pay found in mail the briefing already reads: a billing word plus an explicit due-date label with a date
 * next to it. Matching is by fixed patterns only; message text never reaches rules, grants or tools. Only the date
 * and the amount are taken from the text, and the heuristics miss bills and can flag mail that is not one.
 */
export type Bill = { dueDate: string; amount: string | null; daysLeft: number; amountsDiffer?: true };

const DAY_MS = 86_400_000;
/** A due date this many days in the past is an old message, not a bill still open; further ahead than FUTURE_DAYS is not yet worth listing. */
export const OVERDUE_DAYS = 30;
export const FUTURE_DAYS = 60;
/** A bill due within this many days is flagged urgent. */
export const SOON_DAYS = 3;
/** An overdue bill stays urgent this many days after its due date; after that it is still listed, as normal, until OVERDUE_DAYS. */
export const OVERDUE_URGENT_DAYS = 7;

const SPECIFIC_BILL_WORDS = new RegExp(`\\b(?:boleto|fatura|invoice|cobran[cç]a|mensalidade|contas?\\s+a\\s+pagar|conta\\s+(?:de\\s+)?(?:luz|[aá]gua|g[aá]s|telefone|celular|internet|energia|condom[ií]nio)|your\\s+(?:bill|statement)|bill\\s+is\\s+due|(?:payment|amount)\\s+(?:is\\s+)?due|pagamento\\s+pendente)\\b`, 'i');
const MONTHS = ['janeiro', 'fevereiro', 'marco', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const MONTH_NAMES = MONTHS.map(m => m === 'marco' ? 'mar[cç]o' : m).join('|');
const DATE = `(\\d{4})-(\\d{2})-(\\d{2})|(\\d{1,2})/(\\d{1,2})(?:/(\\d{4}|\\d{2}))?|(\\d{1,2}) de (${MONTH_NAMES})(?: de (\\d{4}))?`;
const LABEL_RIGHT_BEFORE_DATE = 'vencimento|venc\\.|vence(?:r[aá])?(?:\\s+(?:em|dia|no\\s+dia)|\\s*:)|vencid[oa]\\s+(?:em|desde|dia)|due(?:\\s+date|\\s+on|\\s+by)?|(?:pague|pagar|pagamento)\\s+at[eé]|payable\\s+by|pay\\s+by';
const DUE_DATE = new RegExp(`\\b(?:${LABEL_RIGHT_BEFORE_DATE})(?![a-z])[\\s:.\\-–]{0,4}(?:(?:em|dia|no\\s+dia)\\s+)?(?:dia\\s+)?(?:${DATE})`, 'gi');
const EARLIER_BILL = /\b(?:anterior|anteriores|previous|prior|passad[ao])\b/i;
const CURRENCY = '(?:R\\$|US\\$|BRL|USD|EUR|€|\\$)\\s*(\\d{1,3}(?:\\.\\d{3})+,\\d{2}|\\d{1,3}(?:,\\d{3})+\\.\\d{2}|\\d+[.,]\\d{2}|\\d+)';
const TOTAL_AMOUNT = new RegExp(`\\b(?:total|valor|amount|value|montante)\\b[^\\d\\n]{0,20}?(${CURRENCY})`, 'gi');
const ANY_AMOUNT = new RegExp(CURRENCY, 'gi');
const CLAUSE_BREAK = /\n|[.;,]\s/;

const inEarlierBillClause = (text: string, end: number) => EARLIER_BILL.test(text.slice(0, end).split(CLAUSE_BREAK).at(-1)!);

/** How the briefing flags a bill `daysLeft` days from today (negative: overdue). */
export function billTiming(daysLeft: number): { reason: 'bill_overdue' | 'bill_due_soon' | 'bill_upcoming'; urgency: 'urgent' | 'normal' } {
  return daysLeft < 0 ? { reason: 'bill_overdue', urgency: daysLeft >= -OVERDUE_URGENT_DAYS ? 'urgent' : 'normal' } : daysLeft <= SOON_DAYS ? { reason: 'bill_due_soon', urgency: 'urgent' } : { reason: 'bill_upcoming', urgency: 'normal' };
}

/** Whole days from `today` to `date`, both YYYY-MM-DD; null when either is not a calendar date. */
export function daysUntil(today: string, date: string): number | null {
  const [a, b] = [today, date].map(text => { const [y, m, d] = text.split('-').map(Number); return dayNumber(y, m, d); });
  return a === null || b === null ? null : b - a;
}

const dayNumber = (year: number, month: number, day: number): number | null => {
  const t = Date.UTC(year, month - 1, day);
  const d = new Date(t);
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day ? t / DAY_MS : null;
};
const pad = (n: number) => String(n).padStart(2, '0');

/** The bill in a message, relative to `today` (YYYY-MM-DD, the briefing's local date), or null when it is not an open bill. */
export function detectBill(message: Pick<MailMessage, 'subject' | 'body'>, today: string): Bill | null {
  const text = `${message.subject}\n${message.body}`;
  if (!SPECIFIC_BILL_WORDS.test(text)) return null;
  const own = (pattern: RegExp) => [...text.matchAll(pattern)]
    .map(match => ({ match, at: match.index ?? 0 }))
    .filter(({ match, at }) => !inEarlierBillClause(text, at + match[0].length));
  const labelled = own(TOTAL_AMOUNT);
  const amounts = (labelled.length ? labelled.map(({ match, at }) => ({ at, value: match[1] })) : own(ANY_AMOUNT).map(({ match, at }) => ({ at, value: match[0] })))
    .map(({ at, value }) => ({ at, value: value.replace(/\s+/g, ' ').trim() }));
  const gap = (at: number) => amounts.length ? Math.min(...amounts.map(amount => Math.abs(amount.at - at))) : 0;
  const dateFound = own(DUE_DATE).sort((a, b) => gap(a.at) - gap(b.at) || a.at - b.at)[0];
  if (!dateFound) return null;
  const m = dateFound.match;
  const amount = [...amounts].sort((a, b) => Math.abs(a.at - dateFound.at) - Math.abs(b.at - dateFound.at))[0]?.value ?? null;
  const [ty, tm, td] = today.split('-').map(Number);
  const todayNumber = dayNumber(ty, tm, td);
  if (todayNumber === null) return null;
  let year: number, month: number, day: number;
  if (m[1]) { year = Number(m[1]); month = Number(m[2]); day = Number(m[3]); }
  else if (m[4]) { month = Number(m[5]); day = Number(m[4]); year = m[6] ? (m[6].length === 2 ? 2000 + Number(m[6]) : Number(m[6])) : nearestYear(ty, month, day, todayNumber); }
  else { month = MONTHS.indexOf(m[8].toLowerCase().replace('ç', 'c')) + 1; day = Number(m[7]); year = m[9] ? Number(m[9]) : nearestYear(ty, month, day, todayNumber); }
  const due = dayNumber(year, month, day);
  if (due === null) return null;
  const daysLeft = due - todayNumber;
  if (daysLeft < -OVERDUE_DAYS || daysLeft > FUTURE_DAYS) return null;
  return { dueDate: `${year}-${pad(month)}-${pad(day)}`, amount, daysLeft, ...(new Set(amounts.map(a => a.value)).size > 1 ? { amountsDiffer: true as const } : {}) };
}

function nearestYear(thisYear: number, month: number, day: number, todayNumber: number): number {
  let best = thisYear, gap = Infinity;
  for (const year of [thisYear - 1, thisYear, thisYear + 1]) {
    const n = dayNumber(year, month, day);
    if (n !== null && Math.abs(n - todayNumber) < gap) { best = year; gap = Math.abs(n - todayNumber); }
  }
  return best;
}
