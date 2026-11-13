// Replays historical `approve-effect` gate asks from Pi session transcripts through the current
// `classifyEffects` + `autonomy.json` gate, labels them (`needed`, `needless-still-asks`, `fixed`),
// and prints a summary (or JSON with `--json`). Read-only against sessions and profile files.
//
// usage: node --import tsx scripts/gate-replay.mjs [--sessions DIR] [--autonomy FILE] [--json] [--out FILE]
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { classifyEffects, decide, gitRepo, parseContract } from '../src/autonomy.ts';
import { judgeSelfEdit } from '../src/autonomy-self-edit.ts';
import { touchesContract } from '../src/authorization.ts';

const DEFAULT_SESSIONS = join(homedir(), '.pi', 'agent', 'sessions');
const DEFAULT_AUTONOMY = join(homedir(), '.optchat', 'profiles', 'swlucas05', 'autonomy.json');

const OUTCOME_RANK = { unanswered: 0, denied: 1, approved: 2 };

/** Recursively lists `.jsonl` files under `dir`. */
function walkJsonl(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    for (const entry of readdirSync(cur, { withFileTypes: true })) {
      const full = join(cur, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(full);
    }
  }
  return out.sort();
}

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(part => (part && typeof part.text === 'string' ? part.text : '')).join('\n');
}

/** Parses original action(s) and rule from the gate refusal message. */
export function parseAskMeta(text) {
  const actions = [];
  let rule;

  const contractMatch = /autonomy\.json says this waits for the operator:\s*([a-z-]+)\s+on\s+[^:]+:\s*ask(?:\s*\(rule\s+([^)]+)\))?/i.exec(text);
  if (contractMatch) {
    actions.push(contractMatch[1].toLowerCase());
    if (contractMatch[2]) rule = contractMatch[2].trim();
  }

  if (/Only the operator changes autonomy\.json/i.test(text)) {
    if (!actions.includes('autonomy-self-edit')) actions.push('autonomy-self-edit');
    rule ??= 'protected:autonomy.json';
  }

  if (/autonomy\.json is unreadable/i.test(text)) {
    rule ??= 'unreadable:autonomy.json';
  }

  const advisorMatch = /The approval advisor[^:]*refused it:\s*([^.]+)/i.exec(text);
  if (advisorMatch && !rule) {
    rule = `advisor:${advisorMatch[1].trim().slice(0, 80)}`;
  } else if (/The approval advisor was unavailable/i.test(text) && !rule) {
    rule = 'advisor:unavailable';
  }

  const kindMatch = /Not executed:\s*\S+\s+is a\s+([a-z0-9 -]+?)\s+effect\b/i.exec(text);
  if (kindMatch) {
    const normalized = kindMatch[1].trim().toLowerCase().replace(/\s+/g, '-');
    if (!actions.includes(normalized)) actions.push(normalized);
  }

  return { actions: actions.length ? actions : ['unknown'], rule };
}

function commandOf(tool, input) {
  if (input && typeof input === 'object') {
    if (typeof input.command === 'string') return input.command;
    if (typeof input.code === 'string') return input.code;
    if (typeof input.path === 'string') return `${tool} ${input.path}`;
    return JSON.stringify(input);
  }
  return String(input ?? '');
}

/** Extracts and deduplicates every `approve-effect <24 hex>` gate ask from `.jsonl` files under `sessionsDir`. */
export function extractGateAsks(sessionsDir) {
  const files = walkJsonl(sessionsDir);
  const byId = new Map();

  for (const file of files) {
    const raw = readFileSync(file, 'utf8');
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const entries = [];
    for (const line of lines) {
      try { entries.push(JSON.parse(line)); } catch { /* skip malformed JSONL line */ }
    }

    let cwd = '';
    const toolCalls = new Map();
    const fileAsks = [];

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (entry?.type === 'session' && typeof entry.cwd === 'string') {
        cwd = entry.cwd;
        continue;
      }
      if (entry?.type !== 'message' || !entry.message) continue;
      const msg = entry.message;

      if (msg.role === 'assistant' && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block?.type === 'toolCall' && typeof block.id === 'string') {
            toolCalls.set(block.id, { tool: block.name ?? 'unknown', input: block.arguments ?? {} });
          }
        }
        continue;
      }

      if (msg.role === 'toolResult') {
        const text = textFromContent(msg.content);
        if (!text.includes('Not executed:')) continue;
        const m = /\bapprove-effect ([a-f0-9]{24})\b/.exec(text);
        if (!m) continue;

        const id = m[1];
        const call = toolCalls.get(msg.toolCallId);
        const tool = msg.toolName || call?.tool || 'unknown';
        const input = call?.input ?? {};
        const timestamp = typeof entry.timestamp === 'string'
          ? entry.timestamp
          : (typeof msg.timestamp === 'number' ? new Date(msg.timestamp).toISOString() : '');
        const { actions, rule } = parseAskMeta(text);

        fileAsks.push({
          index: i,
          id,
          timestamp,
          cwd,
          tool,
          input,
          command: commandOf(tool, input),
          actions,
          rule,
          outcome: 'unanswered',
          sourceFile: file,
        });
      }
    }

    // Resolve outcomes by scanning subsequent user messages in the same transcript.
    for (const ask of fileAsks) {
      for (let j = ask.index + 1; j < entries.length; j++) {
        const next = entries[j];
        if (next?.type !== 'message' || next.message?.role !== 'user') continue;
        const utext = textFromContent(next.message.content).trim();
        if (utext.includes(`approve-effect ${ask.id}`)) {
          ask.outcome = 'approved';
          break;
        }
        if (/^Denied by the operator, do not run or retry:/i.test(utext) || /^\/deny\b/i.test(utext)) {
          ask.outcome = 'denied';
          break;
        }
      }

      const prev = byId.get(ask.id);
      if (!prev) {
        const { index: _idx, ...clean } = ask;
        byId.set(ask.id, clean);
      } else {
        const betterOutcome = OUTCOME_RANK[ask.outcome] > OUTCOME_RANK[prev.outcome] ? ask.outcome : prev.outcome;
        const hasInput = Object.keys(ask.input || {}).length > Object.keys(prev.input || {}).length;
        byId.set(ask.id, {
          ...(hasInput ? ask : prev),
          outcome: betterOutcome,
          timestamp: prev.timestamp || ask.timestamp,
          cwd: prev.cwd || ask.cwd,
        });
      }
    }
  }

  return [...byId.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

const NEEDED_ACTIONS = new Set([
  'production-write',
  'deploy',
  'paid',
  'message',
  'consent',
  'force-push',
  'database-destructive',
]);

const TEMP_OR_BUILD_TARGET = /(?:^|\/)(?:node_modules|dist|target|\.next|__pycache__|\.repro|\.scratch|tmp|temp|worktrees\/_tmp)(?:\/|$)|^\/tmp(?:\/|$)|^[a-z]:\/tmp(?:\/|$)/i;

/** Heuristic for whether a `touchesContract` call actually writes the live `autonomy.json` vs merely mentions/reads/mirrors it. */
function isRealContractWrite(item) {
  if (item.tool === 'edit' || item.tool === 'write') {
    const p = String(item.input?.path ?? '').replaceAll('\\', '/').toLowerCase();
    return p.endsWith('/autonomy.json') || p === 'autonomy.json';
  }
  const cmd = item.command;
  if (/\btools\.(?:edit|write)\s*\(/.test(cmd)) {
    return /path\s*:\s*['"][^'"]*autonomy\.json['"]/i.test(cmd);
  }
  // Shell: gh pr create/edit/comment or git commit/add/push only mention autonomy.json in prose/metadata.
  if (/^\s*(?:cd\s+[^;&|\n]+&&\s*)?(?:git\s+(?:add|commit|push)|gh\s+(?:pr|issue)\s+)/i.test(cmd) && !/>+\s*\S*autonomy\.json/i.test(cmd)) {
    return false;
  }
  // Copying TO a mirror (payload/...) is not writing the live contract.
  if (/\bcp\s+[^\n]*autonomy\.json\s+[^\n]*payload\//i.test(cmd)) return false;
  // Read-only node -e without fs write calls.
  if (/\bnode\s+-e\b/.test(cmd) && !/\b(?:writeFile|appendFile|copyFile|rename|unlink|rm)(?:Sync)?\s*\(/i.test(cmd)) return false;
  return true;
}

/**
 * Classifies a replayed ask into `fixed`, `needed`, or `needless-still-asks`.
 * `needed` covers: production write, deploy, paid run, message to a third party, consent,
 * force-push, account/credential change, destructive DB, delete of non-regenerable data.
 */
export function labelReplayItem(item, replay) {
  if (!replay.wouldAsk) return 'fixed';

  if (replay.touchesContract) {
    return isRealContractWrite(item) ? 'needed' : 'needless-still-asks';
  }

  const actions = replay.effects.map(e => e.action);
  if (actions.some(a => NEEDED_ACTIONS.has(a))) return 'needed';

  // Account/credential change patterns in shell commands
  if (/\b(?:gh\s+auth\s+(?:login|logout|switch|token)|npm\s+(?:login|adduser|token)|aws\s+configure|passwd|chpasswd|ssh-keygen)\b/i.test(item.command)) {
    return 'needed';
  }

  // Delete of non-regenerable data (recursive-delete or discard not on merged/temp/build targets)
  for (const eff of replay.effects) {
    if (eff.action === 'recursive-delete') {
      const allRegenerable = eff.targets.length > 0 && eff.targets.every(t => TEMP_OR_BUILD_TARGET.test(t));
      if (!allRegenerable) return 'needed';
    }
    if (eff.action === 'discard') {
      const allSafe = eff.targets.includes('merged-branch') || eff.targets.includes('worktree-cleanup') || eff.targets.includes('pc-maintenance');
      if (!allSafe) return 'needed';
    }
  }

  return 'needless-still-asks';
}

/** Redacts tokens, API keys, passwords, and bearer secrets from command strings. */
export function redactSecrets(text) {
  return String(text ?? '')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[REDACTED]')
    .replace(/\b(sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{12,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{20,})\b/g, '[REDACTED]')
    .replace(/([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASS|AUTH)[A-Z0-9_]*=)("[^"]*"|'[^']*'|\S+)/gi, '$1[REDACTED]')
    .replace(/([?&](?:token|key|secret|password|auth)=)[^&\s'"]+/gi, '$1[REDACTED]');
}

/** ISO week key `YYYY-Www` from an ISO timestamp. */
function isoWeek(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return 'unknown';
  const utc = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((utc - yearStart) / 86400000 + 1) / 7);
  return `${utc.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** Normalized pattern key for grouping `needless-still-asks` calls. */
export function patternOf(item, replay) {
  const action = replay.decision?.effect?.action ?? replay.effects[0]?.action ?? item.actions[0] ?? 'unknown';
  const cmd = redactSecrets(item.command).replace(/\s+/g, ' ').trim();
  const head = cmd.split(' ').slice(0, 4).join(' ');
  return `${action} | ${item.tool}: ${head.slice(0, 72)}`;
}

/** Replays extracted asks against `contract` and `contractDir`. */
export function replayAsks(asks, { contract, contractDir, repo = gitRepo }) {
  return asks.map(item => {
    const call = { tool: item.tool, input: item.input, cwd: item.cwd || process.cwd() };
    const isContractTouch = contractDir ? touchesContract(call, contractDir) : false;
    let wouldAsk = false;
    let effects = [];
    let decision;
    let selfEditReason;

    if (isContractTouch) {
      const self = judgeSelfEdit(contractDir, call);
      wouldAsk = !(self?.ok);
      selfEditReason = self?.reason;
    } else {
      effects = classifyEffects(call, repo);
      decision = decide(contract, effects);
      wouldAsk = decision.level === 'ask';
    }

    const replay = { wouldAsk, touchesContract: isContractTouch, effects, decision, selfEditReason };
    const label = labelReplayItem(item, replay);
    return { ...item, replay, label };
  });
}

/** Builds the summary object from replayed items. */
export function summarizeReplay(replayed) {
  const byLabel = { needed: 0, 'needless-still-asks': 0, fixed: 0 };
  const byOutcome = { approved: 0, denied: 0, unanswered: 0 };
  const byAction = {};
  const byWeek = {};
  const needlessPatterns = new Map();

  for (const item of replayed) {
    byLabel[item.label] = (byLabel[item.label] ?? 0) + 1;
    byOutcome[item.outcome] = (byOutcome[item.outcome] ?? 0) + 1;

    const actions = item.replay.touchesContract
      ? ['autonomy-self-edit']
      : (item.replay.effects.length ? [...new Set(item.replay.effects.map(e => e.action))] : item.actions);
    for (const action of actions) {
      if (!byAction[action]) byAction[action] = { total: 0, needed: 0, 'needless-still-asks': 0, fixed: 0 };
      byAction[action].total++;
      byAction[action][item.label]++;
    }

    const week = isoWeek(item.timestamp);
    if (!byWeek[week]) byWeek[week] = { total: 0, needed: 0, 'needless-still-asks': 0, fixed: 0 };
    byWeek[week].total++;
    byWeek[week][item.label]++;

    if (item.label === 'needless-still-asks') {
      const pat = patternOf(item, item.replay);
      const cur = needlessPatterns.get(pat) ?? {
        pattern: pat,
        count: 0,
        action: item.replay.decision?.effect?.action ?? item.replay.effects[0]?.action ?? item.actions[0] ?? 'unknown',
        rule: item.replay.decision?.rule ? `${item.replay.decision.rule.action} ${item.replay.decision.rule.scope.join(',')} (${item.replay.decision.rule.level})` : 'no matching rule',
        example: redactSecrets(item.command).replace(/\s+/g, ' ').trim().slice(0, 200),
      };
      cur.count++;
      needlessPatterns.set(pat, cur);
    }
  }

  const topNeedless = [...needlessPatterns.values()]
    .sort((a, b) => b.count - a.count || a.pattern.localeCompare(b.pattern))
    .slice(0, 10);

  return {
    total: replayed.length,
    byLabel,
    byOutcome,
    byAction: Object.fromEntries(Object.entries(byAction).sort((a, b) => b[1].total - a[1].total)),
    byWeek: Object.fromEntries(Object.entries(byWeek).sort((a, b) => a[0].localeCompare(b[0]))),
    topNeedless,
  };
}

function formatTextSummary(summary) {
  const lines = [];
  lines.push(`Gate Replay Summary (total distinct asks: ${summary.total})`);
  lines.push(`Labels: needed=${summary.byLabel.needed}, needless-still-asks=${summary.byLabel['needless-still-asks']}, fixed=${summary.byLabel.fixed}`);
  lines.push(`Outcomes: approved=${summary.byOutcome.approved}, denied=${summary.byOutcome.denied}, unanswered=${summary.byOutcome.unanswered}`);
  lines.push('');
  lines.push('By Action:');
  for (const [action, counts] of Object.entries(summary.byAction)) {
    lines.push(`  ${action.padEnd(22)} total=${String(counts.total).padStart(3)}  needed=${String(counts.needed).padStart(3)}  needless=${String(counts['needless-still-asks']).padStart(3)}  fixed=${String(counts.fixed).padStart(3)}`);
  }
  lines.push('');
  lines.push('By Week:');
  for (const [week, counts] of Object.entries(summary.byWeek)) {
    lines.push(`  ${week}  total=${String(counts.total).padStart(3)}  needed=${String(counts.needed).padStart(3)}  needless=${String(counts['needless-still-asks']).padStart(3)}  fixed=${String(counts.fixed).padStart(3)}`);
  }
  lines.push('');
  lines.push('Top 10 needless-still-asks patterns:');
  if (!summary.topNeedless.length) {
    lines.push('  (none)');
  } else {
    summary.topNeedless.forEach((p, idx) => {
      lines.push(`  ${idx + 1}. (${p.count}x) ${p.pattern}`);
      lines.push(`     rule: ${p.rule}`);
      lines.push(`     example: ${p.example}`);
    });
  }
  return lines.join('\n');
}

function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      sessions: { type: 'string', default: DEFAULT_SESSIONS },
      autonomy: { type: 'string', default: DEFAULT_AUTONOMY },
      json: { type: 'boolean', default: false },
      out: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    console.log('usage: node --import tsx scripts/gate-replay.mjs [--sessions DIR] [--autonomy FILE] [--json] [--out FILE]');
    return;
  }

  const autonomyPath = resolve(values.autonomy);
  const contract = parseContract(JSON.parse(readFileSync(autonomyPath, 'utf8')));
  const contractDir = resolve(autonomyPath, '..');
  const asks = extractGateAsks(values.sessions);
  const replayed = replayAsks(asks, { contract, contractDir });
  const summary = summarizeReplay(replayed);

  if (values.out) {
    writeFileSync(values.out, JSON.stringify({ summary, items: replayed.map(({ replay, ...rest }) => ({ ...rest, label: rest.label, currentActions: replay.effects.map(e => e.action), wouldAsk: replay.wouldAsk })) }, null, 2));
  }
  if (values.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(formatTextSummary(summary));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
