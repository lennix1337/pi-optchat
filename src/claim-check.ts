import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { textContent } from './transcript.ts';

/**
 * A reply's verifiable claims that no output of the run shows: a pass count ("31/31", "105 de 105"), a commit hash, a file:line
 * reference, a merged PR or "no ar" with no health check. The operator reads them as observed facts (13-18/11: "31/31", "no ar",
 * "causa encontrada" sent with no output behind them), so the run gets one chance to check them before the reply leaves, and what
 * is still unbacked goes out marked.
 */
export const CLAIM_CHECK_PREFIX = '[OptChat claim check]';

const KEYWORD = /\b(?:test|teste|testes|tests|pass|passed|passou|passaram|passando|verde|green|checks?|specs?|suites?|ok|falh\w*|fail\w*|validad\w*|verificad\w*)\b|✓/iu;
const MERGED = /\b(?:mesclad[oa]s?|merged|mergead[oa]s?|entrou na main)\b/iu;
const MERGE_TO_COME = /(?:\b(?:quando|depois\s+que|assim\s+que|ap[oó]s|at[eé]\s+que|caso|se|once|when|after|until|if)\b[^.;:,]{0,40}|\b(?:for|forem|estiver|estiverem|seja|sejam)\s+)$/iu;
const LIVE = /\b(?:no ar|est[aá] live|deployed|deployad[oa])\b/iu;
const LIVE_EVIDENCE = /\b(?:200|healthy|rollouts? done|RESUMO)\b/u;
const RELOADED = /\b(?:reloaded|recarregad[oa]s?)\b|\breload\s+(?:feito|conclu[ií]do|done|completed?)\b|\brecarga\s+(?:feita|conclu[ií]da)\b/iu;
const RELOAD_NOT_DONE = /(?:\b(?:n[aã]o|ainda n[aã]o|not|nem|sem|precisa|falta|ser|be|needs?|must|should|deve|para|pra)\b[^.]{0,30}|\bse\s+)$/iu;
const RELOAD_EVIDENCE = /\[optchat-reload-resume\]|Pi reloaded natively|Reload nativo conclu|"Código carregado no Pi":\{[^}]*"down":false[^}]*Pi carregou às \d\d\/\d\d \d\d:\d\d; o HEAD/iu;


const DIFF_REVIEWED = /\b(?:revisei|revisado|revisada|reviewed)\b[^.;]{0,25}\b(?:diff|patch|PR|pull request)\b|\b(?:diff|patch)\s+(?:revisado|reviewed)\b/iu;
const DIFF_EVIDENCE = /^diff --git |^@@ .*@@|\b\d+ files? changed\b|^\s*\S+\s+\|\s+\d+\s+[+-]+/mu;

const FILE_EXT = 'ts|tsx|mts|cts|js|jsx|mjs|cjs|json|jsonc|jsonl|md|mdx|ya?ml|toml|ini|cfg|conf|env|sh|bash|zsh|ps1|psm1|bat|cmd|py|pyi|rs|go|java|kt|kts|rb|php|c|h|cc|cpp|cxx|hh|hpp|cs|fs|swift|sql|css|scss|sass|less|html?|xml|svg|vue|svelte|astro|prisma|graphql|gql|proto|tf|hcl|lua|dart|exs?|erl|zig|scala|groovy|gradle|cmake|mk|txt|csv|log|lock';
const PATH_LINE = new RegExp(
  `(?<![\\w/\\\\.-])((?:[A-Za-z]:[/\\\\]|/)?(?:[\\w@.-]+[/\\\\])*\\.?[\\w-][\\w.-]*\\.(?:${FILE_EXT})):([1-9]\\d{0,6})(?!\\.\\d|[\\w/\\\\])`,
  'giu',
);

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function pathLineSeen(normEvidence: string, rawPath: string, line: number): boolean {
  const path = rawPath.replaceAll('\\', '/').replace(/^(?:\.\/)+/u, '').toLowerCase();
  if (!normEvidence.includes(path)) return false;
  const escPath = escapeRegex(path);
  if (new RegExp(`(?<![\\w.-])${escPath}(?:(?::|#l)${line}(?!\\d)|-${line}-|\\(${line}(?:,\\d+)?\\))`, 'u').test(normEvidence)) return true;
  for (const m of normEvidence.matchAll(new RegExp(`(?<![\\w.-])${escPath}(?::|#l)(\\d+)-l?(\\d+)(?!\\d)`, 'gu'))) {
    if (Number(m[1]) <= line && line <= Number(m[2])) return true;
  }
  if (normEvidence.includes('p="')) {
    for (const m of normEvidence.matchAll(new RegExp(`(?<![\\w.-])${escPath}"`, 'gu'))) {
      const open = normEvidence.lastIndexOf('<', m.index);
      const close = normEvidence.indexOf('>', m.index);
      if (open < 0 || close < 0 || normEvidence.slice(open, m.index).includes('>') || normEvidence.slice(open, close).includes('\n')) continue;
      if (!/\bp="[^"]*$/u.test(normEvidence.slice(open, m.index))) continue;
      const l = /\bl="(\d+)(?:-(\d+))?"/u.exec(normEvidence.slice(open, close));
      if (l && Number(l[1]) <= line && line <= Number(l[2] ?? l[1])) return true;
    }
  }
  if (normEvidence.includes('@@ -')) {
    const fileHeader = new RegExp(`^(?:\\+\\+\\+ (?:b/)?|--- (?:a/)?)(?:[^\\n]*\\/)?${escPath}(?:\\t|\\r|$)`, 'u');
    let inFile = false;
    for (const row of normEvidence.split('\n')) {
      if (row.startsWith('diff --git ')) { inFile = false; continue; }
      if (row.startsWith('--- ')) { inFile = fileHeader.test(row); continue; }
      if (row.startsWith('+++ ')) {
        if (fileHeader.test(row)) inFile = true;
        else if (!row.startsWith('+++ /dev/null')) inFile = false;
        continue;
      }
      if (!inFile) continue;
      const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(row);
      if (!hunk) continue;
      const oldStart = Number(hunk[1]), oldCount = Number(hunk[2] ?? 1);
      const newStart = Number(hunk[3]), newCount = Number(hunk[4] ?? 1);
      if ((oldCount > 0 && oldStart <= line && line < oldStart + oldCount) ||
        (newCount > 0 && newStart <= line && line < newStart + newCount)) return true;
    }
  }
  return false;
}

function runnerShows(evidence: string, a: number, b: number): boolean {
  for (const m of evidence.matchAll(new RegExp(`\\bpass(?:ed)?\\s*[:=]?\\s*${a}\\b|\\b${a}\\s+pass(?:ed|ing)?\\b`, 'giu'))) {

    const near = evidence.slice(evidence.lastIndexOf('\n', m.index) + 1).split('\n').slice(0, 3).join('\n');
    if (a === b ? !/\bfail(?:ed|ures?)?\s*[:=]?\s*[1-9]|\b[1-9]\d*\s+fail(?:ed|ing|ures?)?\b/iu.test(near) : new RegExp(`\\b(?:tests?|total)\\s*[:=]?\\s*${b}\\b|\\(${b}\\)`, 'iu').test(near)) return true;
  }
  return false;
}

function sentences(text: string): string[] {
  return text.replace(/`/gu, '').split(/(?<=[.!?;])\s+|\n+/u).filter(Boolean);
}

/** The text every tool result and incoming message of the run showed: what a claim may rest on. */
export function evidenceText(messages: readonly AgentMessage[]): string {
  return messages.filter(m => m.role !== 'assistant').map(m => textContent((m as { content?: unknown }).content, false)).join('\n');
}

/**
 * What the session branch holds that may back a claim: its messages and the notices injected between runs (gitwatch's
 * "#167 merged af268f09" is a custom message, not a message entry, and was left out: a merge it reported was flagged as unbacked).
 */
export function branchEvidenceMessages(entries: readonly { type: string; message?: AgentMessage; content?: unknown }[]): AgentMessage[] {
  return entries.flatMap((e): AgentMessage[] => e.type === 'message' && e.message ? [e.message]
    : e.type === 'custom_message' ? [{ role: 'user', content: e.content, timestamp: 0 } as AgentMessage] : []);
}

export function unbackedClaims(reply: string, evidence: string): string[] {
  const out = new Set<string>();
  let lowercaseEvidence: string | undefined;
  let normPathEvidence: string | undefined;
  const seen = (token: string) => evidence.includes(token);
  for (const s of sentences(reply)) {
    if (KEYWORD.test(s)) {
      for (const m of s.matchAll(/(?<![\w/]|\d[.,])([1-9]\d{0,5})(?:\s*\/\s*|\s+(?:de|of)\s+)([1-9]\d{0,5})(?![\w/]|[.,]\d)/gu)) {
        const [a, b] = [Number(m[1]), Number(m[2])];
        if (a <= b && ![`${a}/${b}`, `${a} de ${b}`, `${a} of ${b}`].some(seen) && !runnerShows(evidence, a, b)) out.add(m[0].trim());
      }
    }
    for (const m of s.matchAll(/(?<![\w/.-])([0-9a-f]{7,40})(?![\w/-])/gu)) {
      const sha = m[1]!;
      if (/\d/u.test(sha) && /[a-f]/u.test(sha) && !(lowercaseEvidence ??= evidence.toLowerCase()).includes(sha.slice(0, 7))) out.add(sha);
    }
    for (const m of s.matchAll(PATH_LINE)) {
      normPathEvidence ??= (lowercaseEvidence ??= evidence.toLowerCase()).replaceAll('\\', '/');
      if (!pathLineSeen(normPathEvidence, m[1]!, Number(m[2]))) out.add(m[0]);
    }
    for (const w of s.matchAll(new RegExp(MERGED.source, 'giu'))) {

      const before = s.slice(0, w.index);
      if (/\b(?:n[aã]o|not|nem)\b[^.#]{0,25}$/iu.test(before) || MERGE_TO_COME.test(before)) continue;
      const near = s.slice(Math.max(0, w.index - 40), w.index + w[0].length + 40);
      for (const m of near.matchAll(/#(\d{1,6})\b/gu)) {
        const n = m[1]!;
        if (!new RegExp(`(?:#|/pull/|PR\\s?)${n}\\b[\\s\\S]{0,200}\\b(?:MERGED|merged|Merged)\\b|\\b(?:MERGED|merged|Merged)\\b[\\s\\S]{0,200}(?:#|/pull/|PR\\s?)${n}\\b`, 'u').test(evidence)) out.add(`#${n} mesclado`);
      }
    }
    for (const w of s.matchAll(new RegExp(RELOADED.source, 'giu'))) {
      if (!RELOAD_NOT_DONE.test(s.slice(Math.max(0, w.index - 40), w.index)) && !RELOAD_EVIDENCE.test(evidence)) out.add('reload feito');
    }
    if (DIFF_REVIEWED.test(s) && !RELOAD_NOT_DONE.test(s.slice(0, s.search(DIFF_REVIEWED))) && !DIFF_EVIDENCE.test(evidence)) out.add('diff revisado');
    if (LIVE.test(s) && !/\b(?:n[aã]o|ainda n[aã]o|not)\b[^.]{0,30}\b(?:no ar|live|deployed)/iu.test(s) && !LIVE_EVIDENCE.test(evidence)) out.add('no ar');
  }
  return [...out];
}

/** First-person "I did not confirm/verify/check": the operator's rule is that the run always has a way to check (18/11). */
export const UNCHECKED_ADMISSION = /\b(?:(?:ainda\s+)?n[ãa]o\s+(?:confirmei|verifiquei|conferi|chequei|validei)|I\s+(?:did\s+not|didn't|have\s+not|haven't)\s+(?:confirm|verif|check)\w*)\b/iu;

/** A phrase in quotes is cited, not admitted (describing a check fired it). */
export const withoutQuotes = (s: string): string => s.replace(/"[^"]*"|“[^”]*”|'[^']*'/gu, '');

export const FREE_ACTION = /\b(?:(?:posso|pode|quer que eu|rodo|devo)\b[^?\n]{0,80}\b(?:merge\w*|push\w*|recarreg\w*|reload\w*|reinici\w*|restart\w*|public\w*|publish\w*|pr)|recarrego|reload|reinicio|restart)\b[^?\n]{0,60}\?/iu;

export function freeActionQuestions(reply: string): string[] {
  return sentences(withoutQuotes(reply)).filter(s => FREE_ACTION.test(s));
}

export function uncheckedAdmissions(reply: string): string[] {
  return sentences(reply).filter(s => UNCHECKED_ADMISSION.test(withoutQuotes(s)));
}

/** "Cause not found": the operator's rule (15/11, "se nao sabe pq parou de investigar?") is that a run does not stop at an unknown cause. */
export const ABANDONED_CAUSE = /\b(?:causas?\s+n[ãa]o\s+(?:(?:foi|foram)\s+)?encontrad[ao]s?|sem\s+causa\s+encontrada|causes?\s+(?:(?:is|were|was|still)\s+)*not\s+found)\b/iu;

export function abandonedCauses(reply: string): string[] {
  return sentences(reply).filter(s => ABANDONED_CAUSE.test(withoutQuotes(s)));
}

/** A clock time in UTC ("12:43Z"): the operator reads Brasília time (profile rule; 36 hits in 7 days with no guard). */
export const UTC_CLOCK = /\b\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z\b/u;

export function utcTimes(reply: string): string[] {
  return sentences(reply).filter(s => UTC_CLOCK.test(withoutQuotes(s)));
}

export function claimRetryText(claims: readonly string[], admissions: readonly string[] = [], causes: readonly string[] = [], utc: readonly string[] = [], freeActions: readonly string[] = [], memoryShaped = false): string {
  const parts = [`${CLAIM_CHECK_PREFIX}`];
  if (memoryShaped) parts.push('Your reply is written as a memory summary line (an id range such as `199529-199533`, `id+n|`, `talk:`/`echo:` tags or machine-notice wording), and the operator reads it as a broken answer. Rewrite it for him in Portuguese (pt-BR), in plain sentences, outcome first.');
  if (claims.length) parts.push(`Your reply states facts that no output of this run shows: ${claims.join(', ')}.`);
  if (admissions.length) parts.push(`Your reply admits not having checked: ${admissions.map(a => `"${a}"`).join(' ')} You always have a way to check (operator, 18/11): make the tool call for each one now, in this round. Writing "not verified" again without a call is not an answer; keep it only for what needs something only the operator holds, and name that thing.`);
  if (causes.length) parts.push(`Your reply gives up on a cause: ${causes.map(a => `"${a}"`).join(' ')} Take one more cheap step before sending (read the failing log, run the narrowest test, diff against the last good state) and report what it showed, or ship the diagnostic that would answer it.`);
  if (utc.length) parts.push(`Your reply gives a time in UTC: ${utc.map(a => `"${a}"`).join(' ')} The operator reads Brasília time (UTC-3): convert every time and write it as HH:MM, without Z.`);
  if (freeActions.length) parts.push(`Your reply asks permission for a free action: ${freeActions.map(a => `"${a}"`).join(' ')} Do the action now (it is free) or drop the question. Ask permission only for the operator's reserved actions: production deploy, spending, messages to third parties, account or credential changes, force-push, destructive data deletion, or stopping processes that are not yours or are in use by someone else.`);
  if (claims.length || admissions.length || causes.length || utc.length) parts.push('Before it reaches the operator, check each one with a read-only tool (test run, gh, curl, git log) and correct the reply' +
    (admissions.length ? '' : '. Make the checking call now, in this round; "not verified" is kept only for what needs something only the operator holds, naming that thing') +
    '. Then give the final reply again, in Portuguese.');
  else parts.push('Then give the final reply again, in Portuguese.');
  return parts.join(' ');
}

export function unbackedNote(claims: readonly string[]): string {
  return `⚠️ Não verificado nesta execução: ${claims.join(', ')}.`;
}
