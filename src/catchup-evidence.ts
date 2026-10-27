import { record } from './cache.ts';

export interface ObservedPR { url: string; state: string; head?: string; checks: 'passed' | 'failed' | 'pending' | 'unknown'; source: number; at: string }
export interface ObservedCheck { name: string; root: string; status: string; source: number; at: string }

/** Only JSON records on result lines, including Code Mode's shell-output envelope. Never parse prose, file contents or PR bodies. */
function objects(text: string, depth = 0): Record<string, unknown>[] {
  if (depth > 3) return [];
  const found: Record<string, unknown>[] = [];
  for (const line of text.split('\n')) {
    const raw = line.trim();
    if (!raw.startsWith('{') || !raw.endsWith('}')) continue;
    let value: unknown;
    try { value = JSON.parse(raw); } catch { continue; } // Non-JSON diagnostic, not evidence.
    if (!record(value)) continue;
    found.push(value);
    if (typeof value.output === 'string' && value.exit_code === 0) found.push(...objects(value.output, depth + 1));
  }
  return found;
}

function checkState(rows: unknown): ObservedPR['checks'] {
  if (!Array.isArray(rows) || !rows.length) return 'unknown';
  const states = rows.map(row => record(row) ? String(row.conclusion || row.state || row.status).toUpperCase() : 'UNKNOWN');
  if (states.some(state => ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED'].includes(state))) return 'failed';
  if (states.every(state => ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(state))) return states.every(state => state === 'SUCCESS') ? 'passed' : 'unknown';
  return 'pending';
}

/** Observations are sourced to an echo, not certified current remote state or authorization. */
export function observations(text: string, source: number, at: string) {
  const prs: ObservedPR[] = [], checks: ObservedCheck[] = [];
  const prefix = /^(bash|powershell|codemode|project_checks):\s*/.exec(text);
  if (!prefix) return { prs, checks };
  for (const object of objects(text.slice(prefix[0].length))) {
    if (typeof object.url === 'string' && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(object.url)
      && ['OPEN', 'CLOSED', 'MERGED'].includes(String(object.state))) {
      prs.push({ url: object.url, state: String(object.state), ...(typeof object.headRefOid === 'string' ? { head: object.headRefOid } : {}), checks: checkState(object.statusCheckRollup), source, at });
    }
    if (object.schema === 'pi-ripwire/v1' && object.kind === 'check' && ['passed', 'failed', 'blocked', 'not_started'].includes(String(object.status))) {
      const name = object.name ?? object.check;
      if (typeof name === 'string' && typeof object.root === 'string') checks.push({ name, root: object.root, status: String(object.status), source, at });
    }
  }
  return { prs, checks };
}
