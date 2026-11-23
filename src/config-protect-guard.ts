import type { ToolUse } from './ripwire-first-guard.ts';

type Hooks = { on(event: string, handler: (event: any, ctx: any) => unknown): unknown };

/** Category of check weakening detected by the config-protect guard. */
export type WeakeningKind =
  | 'lint-config'
  | 'tsconfig-strictness'
  | 'test-check'
  | 'lint-disable'
  | 'ci-check';

/** One concrete weakening found in a tool call, naming the affected target and detail. */
export interface WeakeningFinding {
  /** Category of check that was weakened. */
  kind: WeakeningKind;
  /** File path or command surface being modified. */
  target: string;
  /** Specific rule, flag, timeout, directive, or check that was weakened. */
  detail: string;
}

/** Configuration options for the config-protect guard (all defaults are neutral). */
export interface ConfigProtectOptions {
  /** Extra lint/formatter config basenames to protect (case-insensitive). */
  extraProtectedFiles?: readonly string[];
  /** Categories to skip checking (default: none — all categories active). */
  disabledCategories?: readonly WeakeningKind[];
  /** Environment map checked for `OPTCHAT_CONFIG_PROTECT=off` (default: `process.env`). */
  env?: Record<string, string | undefined>;
}

const IGNORE_FILES = new Set([
  '.eslintignore',
  '.prettierignore',
  '.stylelintignore',
  '.markdownlintignore',
  '.lint-comments-ignore',
]);

const LINT_CONFIG_FILES = new Set([
  '.eslintrc',
  '.eslintrc.js',
  '.eslintrc.cjs',
  '.eslintrc.json',
  '.eslintrc.yml',
  '.eslintrc.yaml',
  'eslint.config.js',
  'eslint.config.mjs',
  'eslint.config.cjs',
  'eslint.config.ts',
  'eslint.config.mts',
  'eslint.config.cts',
  '.prettierrc',
  '.prettierrc.js',
  '.prettierrc.cjs',
  '.prettierrc.json',
  '.prettierrc.yml',
  '.prettierrc.yaml',
  'prettier.config.js',
  'prettier.config.cjs',
  'prettier.config.mjs',
  'biome.json',
  'biome.jsonc',
  '.biome.json',
  '.biome.jsonc',
  '.ruff.toml',
  'ruff.toml',
  '.shellcheckrc',
  '.stylelintrc',
  '.stylelintrc.json',
  '.stylelintrc.yml',
  '.stylelintrc.yaml',
  '.stylelintrc.js',
  '.stylelintrc.cjs',
  '.stylelintrc.mjs',
  'stylelint.config.js',
  'stylelint.config.cjs',
  'stylelint.config.mjs',
  'stylelint.config.ts',
  'stylelint.config.mts',
  'stylelint.config.cts',
  '.markdownlint.json',
  '.markdownlint.jsonc',
  '.markdownlint.yaml',
  '.markdownlint.yml',
  '.markdownlint.cjs',
  '.markdownlint.mjs',
  '.markdownlintrc',
  '.markdownlint-cli2.jsonc',
  '.markdownlint-cli2.yaml',
  '.markdownlint-cli2.cjs',
  '.markdownlint-cli2.mjs',
  '.oxlintrc.json',
  'oxlint.config.js',
  'oxlint.config.mjs',
  'oxlint.config.ts',
]);

const LINT_CONFIG_PATTERNS = [
  /^(?:eslint|prettier|stylelint|commitlint|oxlint)\.config(?:\.[A-Za-z0-9_-]+)*\.(?:js|mjs|cjs|ts|mts|cts)$/i,
  /^\.(?:eslintrc|prettierrc|stylelintrc|markdownlintrc)(?:\.[A-Za-z0-9_-]+)*\.(?:js|cjs|mjs|ts|mts|cts|json|jsonc|json5|yml|yaml|toml)$/i,
];

const TS_STRICT_FLAGS = [
  'strict',
  'strictNullChecks',
  'strictFunctionTypes',
  'strictBindCallApply',
  'strictPropertyInitialization',
  'noImplicitAny',
  'noImplicitThis',
  'noImplicitReturns',
  'noUnusedLocals',
  'noUnusedParameters',
  'noUncheckedIndexedAccess',
  'noFallthroughCasesInSwitch',
  'alwaysStrict',
  'exactOptionalPropertyTypes',
  'useUnknownInCatchVariables',
  'noEmitOnError',
  'isolatedModules',
  'verbatimModuleSyntax',
  'erasableSyntaxOnly',
] as const;

const TS_LOOSE_FLAGS = [
  'noCheck',
  'suppressImplicitAnyIndexErrors',
  'suppressExcessPropertyErrors',
] as const;

const TSCONFIG_PATH = /(?:^|[\\/])tsconfig(?:\.[^\\/.]+)*\.jsonc?$/iu;
const TEST_OR_CHECK_PATH = /(?:^|[\\/])(?:test|tests|__tests__|spec|e2e)(?:[\\/])|\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|[\\/])(?:vitest|jest|playwright)\.config\.[cm]?[jt]s$|(?:^|[\\/])\.pi[\\/]checks\.json$/iu;
const CI_PATH = /(?:^|[\\/])\.github[\\/]workflows[\\/][^\\/]+\.ya?ml$|(?:^|[\\/])(?:\.gitlab-ci\.ya?ml|\.circleci[\\/]config\.ya?ml|azure-pipelines\.ya?ml)$/iu;
const DOC_PATH = /\.(?:md|markdown|txt|rst)$/iu;

const RULE_OFF_RE = /(?:['"]off['"]|:\s*0(?=\s*[,}\]\n]|$)|\[\s*0(?=\s*[,\]])|\b(?:recommended|enabled)\s*[:=]\s*false\b|\bdisable\s*=\s*\S)/giu;
const RULE_ERROR_RE = /(?:['"]error['"]|:\s*2(?=\s*[,}\]\n]|$)|\[\s*2(?=\s*[,\]])(?!\d))/giu;
const RULE_WARN_RE = /(?:['"]warn['"]|:\s*1(?=\s*[,}\]\n]|$)|\[\s*1(?=\s*[,\]])(?!\d))/giu;
const IGNORE_BLOCK_RE = /\b(?:ignores|ignorePatterns|extend-ignore|ignore|exclude)\s*[:=]\s*\[([^\]]*)\]/giu;

const TEST_SKIP_RE = /\.skip\b|\bx(?:it|test|describe)\s*\(|\bskip\s*:\s*true\b/gu;
const TEST_RETRIES_NUM_RE = /(?:\bretr(?:y|ies)\s*[:=]\s*|\bretryTimes\s*\(\s*)(\d+)/giu;
const TEST_LIMIT_RE = /(?:["']?(?:timeout|testTimeout|timeoutMs|budget|maxMs|deadline|waitMs)[\w]*["']?\s*[:=]\s*|setTimeout\s*\(\s*|--test-timeout[=\s]+)(\d+(?:_\d+)*)/giu;

const INLINE_DISABLE_RE = /(?:\/\/|\/\*)\s*(eslint-disable(?:-next-line|-line)?|oxlint-disable(?:-next-line|-line)?|biome-ignore|@ts-(?:ignore|nocheck))\b|#\s*(noqa|type:\s*ignore)\b/giu;

const CI_CONTINUE_ON_ERROR_RE = /\bcontinue-on-error\s*:\s*true\b/giu;
const CI_OR_TRUE_RE = /\|\|\s*(?:true|exit\s+0)\b/giu;
const CI_IF_FALSE_RE = /^\s*if\s*:\s*(?:\$\{\{\s*)?false(?:\s*\}\})?\s*$/gimu;
const CI_ACTIVE_CHECK_RUN_RE = /^\s*(?:-\s*)?run\s*:[^\n]*\b(?:test|check|lint|tsc|typecheck|verify|vitest|jest|pytest|eslint|ruff|biome)\b/gimu;

function baseName(filePath: string): string {
  const parts = filePath.replaceAll('\\', '/').split('/');
  return (parts[parts.length - 1] ?? '').toLowerCase();
}

function isLintConfig(filePath: string, extra?: Set<string>): boolean {
  const name = baseName(filePath);
  if (!name) return false;
  return LINT_CONFIG_FILES.has(name)
    || (extra ? extra.has(name) : false)
    || LINT_CONFIG_PATTERNS.some(re => re.test(name));
}

function isIgnoreFile(filePath: string): boolean {
  return IGNORE_FILES.has(baseName(filePath));
}

function countMatches(text: string, re: RegExp): number {
  let count = 0;
  for (const _ of text.matchAll(re)) count++;
  return count;
}

function countIgnoreItems(text: string): number {
  let count = 0;
  for (const match of text.matchAll(IGNORE_BLOCK_RE)) {
    const quoted = match[1].match(/['"][^'"]+['"]/gu);
    count += quoted ? quoted.length : 1;
  }
  return count;
}

function countNonCommentLines(text: string): number {
  return text.split(/\r?\n/u).filter(line => {
    const trimmed = line.trim();
    return trimmed.length > 0 && !trimmed.startsWith('#');
  }).length;
}

function maxNumericMatch(text: string, re: RegExp): number | undefined {
  let max: number | undefined;
  for (const match of text.matchAll(re)) {
    const value = Number(match[1].replaceAll('_', ''));
    if (Number.isFinite(value) && (max === undefined || value > max)) max = value;
  }
  return max;
}

function hasJsonBool(text: string, key: string, value: boolean): boolean {
  return new RegExp(`["']${key}["']\\s*:\\s*${value}\\b`, 'u').test(text);
}

function checkLintConfig(target: string, oldText: string, newText: string, extra?: Set<string>): WeakeningFinding[] {
  const out: WeakeningFinding[] = [];
  if (isIgnoreFile(target)) {
    if (countNonCommentLines(newText) > countNonCommentLines(oldText)) {
      out.push({ kind: 'lint-config', target, detail: 'lint ignore pattern added' });
    }
    return out;
  }
  if (!isLintConfig(target, extra)) return out;

  if (countMatches(newText, RULE_OFF_RE) > countMatches(oldText, RULE_OFF_RE)) {
    out.push({ kind: 'lint-config', target, detail: 'lint rule disabled' });
  } else if (
    countMatches(newText, RULE_ERROR_RE) < countMatches(oldText, RULE_ERROR_RE)
    && countMatches(newText, RULE_WARN_RE) > countMatches(oldText, RULE_WARN_RE)
  ) {
    out.push({ kind: 'lint-config', target, detail: 'lint rule downgraded from error to warn' });
  }
  if (countIgnoreItems(newText) > countIgnoreItems(oldText)) {
    out.push({ kind: 'lint-config', target, detail: 'lint ignore list widened' });
  }
  return out;
}

function checkTsconfig(target: string, oldText: string, newText: string): WeakeningFinding[] {
  if (!TSCONFIG_PATH.test(target)) return [];
  const out: WeakeningFinding[] = [];
  for (const flag of TS_STRICT_FLAGS) {
    if (hasJsonBool(newText, flag, false) && !hasJsonBool(oldText, flag, false)) {
      out.push({ kind: 'tsconfig-strictness', target, detail: `${flag}: false` });
    } else if (oldText && hasJsonBool(oldText, flag, true) && !hasJsonBool(newText, flag, true)) {
      out.push({ kind: 'tsconfig-strictness', target, detail: `${flag}: true removed` });
    }
  }
  for (const flag of TS_LOOSE_FLAGS) {
    if (hasJsonBool(newText, flag, true) && !hasJsonBool(oldText, flag, true)) {
      out.push({ kind: 'tsconfig-strictness', target, detail: `${flag}: true` });
    }
  }
  if (hasJsonBool(oldText, 'skipLibCheck', false) && hasJsonBool(newText, 'skipLibCheck', true)) {
    out.push({ kind: 'tsconfig-strictness', target, detail: 'skipLibCheck: true' });
  }
  if (oldText && countIgnoreItems(newText) > countIgnoreItems(oldText)) {
    out.push({ kind: 'tsconfig-strictness', target, detail: 'tsconfig exclude widened' });
  }
  return out;
}

function checkTestWeakening(target: string, oldText: string, newText: string): WeakeningFinding[] {
  if (!TEST_OR_CHECK_PATH.test(target)) return [];
  const out: WeakeningFinding[] = [];

  if (countMatches(newText, TEST_SKIP_RE) > countMatches(oldText, TEST_SKIP_RE)) {
    out.push({ kind: 'test-check', target, detail: 'test skip added' });
  }

  const prevRetries = maxNumericMatch(oldText, TEST_RETRIES_NUM_RE);
  const nextRetries = maxNumericMatch(newText, TEST_RETRIES_NUM_RE);
  if (nextRetries !== undefined && nextRetries > (prevRetries ?? 0)) {
    out.push({ kind: 'test-check', target, detail: `test retries raised (${prevRetries ?? 0} -> ${nextRetries})` });
  } else if (nextRetries === undefined && /\bretry\b/iu.test(newText) && !/\bretry\b/iu.test(oldText)) {
    out.push({ kind: 'test-check', target, detail: 'test retry added' });
  }

  const prevLimit = maxNumericMatch(oldText, TEST_LIMIT_RE);
  const nextLimit = maxNumericMatch(newText, TEST_LIMIT_RE);
  if (prevLimit !== undefined && nextLimit !== undefined && nextLimit > prevLimit) {
    out.push({ kind: 'test-check', target, detail: `test timeout/budget raised (${prevLimit} -> ${nextLimit})` });
  }

  return out;
}

function checkInlineDisable(target: string, oldText: string, newText: string): WeakeningFinding[] {
  if (!target || DOC_PATH.test(target)) return [];
  const before = [...oldText.matchAll(INLINE_DISABLE_RE)];
  const after = [...newText.matchAll(INLINE_DISABLE_RE)];
  if (after.length <= before.length) return [];
  const labels = [...new Set(after.map(m => (m[1] ?? m[2] ?? 'lint-disable').toLowerCase()))];
  return [{ kind: 'lint-disable', target, detail: `${labels.join(', ')} added` }];
}

function checkCiWorkflow(target: string, oldText: string, newText: string): WeakeningFinding[] {
  if (!CI_PATH.test(target)) return [];
  const out: WeakeningFinding[] = [];
  if (countMatches(newText, CI_CONTINUE_ON_ERROR_RE) > countMatches(oldText, CI_CONTINUE_ON_ERROR_RE)) {
    out.push({ kind: 'ci-check', target, detail: 'continue-on-error: true' });
  }
  if (countMatches(newText, CI_OR_TRUE_RE) > countMatches(oldText, CI_OR_TRUE_RE)) {
    out.push({ kind: 'ci-check', target, detail: 'check error suppressed with || true' });
  }
  if (countMatches(newText, CI_IF_FALSE_RE) > countMatches(oldText, CI_IF_FALSE_RE)) {
    out.push({ kind: 'ci-check', target, detail: 'CI check disabled (if: false)' });
  }
  if (oldText && countMatches(newText, CI_ACTIVE_CHECK_RUN_RE) < countMatches(oldText, CI_ACTIVE_CHECK_RUN_RE)) {
    out.push({ kind: 'ci-check', target, detail: 'CI check step removed or commented out' });
  }
  return out;
}

function checkTextChange(target: string, oldText: string, newText: string, extra?: Set<string>): WeakeningFinding[] {
  return [
    ...checkLintConfig(target, oldText, newText, extra),
    ...checkTsconfig(target, oldText, newText),
    ...checkTestWeakening(target, oldText, newText),
    ...checkInlineDisable(target, oldText, newText),
    ...checkCiWorkflow(target, oldText, newText),
  ];
}

function stripQuoted(command: string): string {
  return command
    .replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2(?=\n|$)/gu, '')
    .replace(/"(?:[^"\\]|\\[\s\S])*"|'[^']*'/gu, '""');
}

function unquoteToken(token: string): string {
  return token.replace(/^['"]|['"]$/gu, '');
}

function checkBash(command: string, extra?: Set<string>): WeakeningFinding[] {
  const out: WeakeningFinding[] = [];
  const unquoted = stripQuoted(command);

  if (/\bgit\s+(?:-\S+\s+)*commit\b[^\n;&|]*(?:\s--no-verify\b|\s-[a-zA-Z]*n[a-zA-Z]*(?=\s|$))/u.test(unquoted)) {
    out.push({ kind: 'ci-check', target: 'bash', detail: 'git commit --no-verify' });
  }
  if (/\bgit\s+(?:-\S+\s+)*push\b[^\n;&|]*\s--no-verify\b/u.test(unquoted)) {
    out.push({ kind: 'ci-check', target: 'bash', detail: 'git push --no-verify' });
  }
  if (/\bgh\s+pr\s+merge\b[^\n;&|]*\s--admin\b/u.test(unquoted)) {
    out.push({ kind: 'ci-check', target: 'bash', detail: 'gh pr merge --admin' });
  }
  if (
    /\bgh\s+api\b/u.test(unquoted)
    && /\b(?:DELETE|PUT|PATCH)\b/u.test(unquoted)
    && /(?:\/protection\b|\/rulesets\b|required_status_checks)/u.test(command)
  ) {
    out.push({ kind: 'ci-check', target: 'bash', detail: 'branch protection / required checks modified' });
  }

  for (const match of unquoted.matchAll(/\b(?:git\s+)?rm\b([^\n;&|]*)/gu)) {
    const args = match[1].trim().split(/\s+/u).map(unquoteToken).filter(a => a && !a.startsWith('-'));
    for (const file of args) {
      if (isLintConfig(file, extra) || isIgnoreFile(file)) {
        out.push({ kind: 'lint-config', target: file, detail: 'lint config removed' });
      } else if (TSCONFIG_PATH.test(file)) {
        out.push({ kind: 'tsconfig-strictness', target: file, detail: 'tsconfig removed' });
      } else if (CI_PATH.test(file)) {
        out.push({ kind: 'ci-check', target: file, detail: 'CI workflow removed' });
      }
    }
  }

  const heredocRe = /(?:^|\n)([^\n]*<<-?\s*(['"]?)(\w+)\2[^\n]*)\n([\s\S]*?)\n\s*\3(?=\s|$)/gu;
  for (const match of command.matchAll(heredocRe)) {
    const target = match[1].match(/(?:>{1,2}|\btee(?:\s+-a)?)\s+(['"]?[^\s'";&|]+['"]?)/u)?.[1];
    if (target) out.push(...checkTextChange(unquoteToken(target), '', match[4], extra));
  }

  for (const line of command.split(/\r?\n|&&|\|\||;/u)) {
    if (/<<-?\s*['"]?\w+['"]?/u.test(line)) continue;
    const redir = line.match(/^(.*?)(?:>{1,2}|\|\s*tee(?:\s+-a)?)\s+(['"]?[^\s'";&|]+['"]?)/u);
    if (redir) {
      const target = unquoteToken(redir[2]);
      out.push(...checkTextChange(target, '', redir[1], extra));
    }
    const sed = line.match(/\bsed\s+(?:-[a-zA-Z]*i[a-zA-Z]*(?:\s+['"][^'"]*['"])?\s+)([\s\S]+)$/u);
    if (sed) {
      const expr = line.match(/['"]s([/|#])([^/|#]*)\1([^/|#]*)\1[a-z]*['"]/u);
      const rest = sed[1].replace(/'[^']*'|"[^"]*"/gu, ' ').trim().split(/\s+/u).filter(a => a && !a.startsWith('-'));
      for (const file of rest) {
        if (expr) out.push(...checkTextChange(file, expr[2], expr[3], extra));
        else if (isLintConfig(file, extra) || isIgnoreFile(file) || TSCONFIG_PATH.test(file) || CI_PATH.test(file)) {
          out.push({ kind: TSCONFIG_PATH.test(file) ? 'tsconfig-strictness' : CI_PATH.test(file) ? 'ci-check' : 'lint-config', target: file, detail: 'in-place sed edit on protected check config' });
        }
      }
    }
  }

  return out;
}

function dedupeFindings(findings: WeakeningFinding[]): WeakeningFinding[] {
  const seen = new Set<string>();
  return findings.filter(f => {
    const key = `${f.kind}|${f.target}|${f.detail}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Detects whether an edit, write, or bash tool call weakens lint rules, tsconfig strictness, tests, inline suppressions, or CI checks. */
export function detectConfigWeakening(call: ToolUse, options: ConfigProtectOptions = {}): WeakeningFinding[] {
  const extra = options.extraProtectedFiles?.length
    ? new Set(options.extraProtectedFiles.map(f => f.toLowerCase()))
    : undefined;
  const disabled = options.disabledCategories?.length ? new Set(options.disabledCategories) : undefined;
  let findings: WeakeningFinding[] = [];

  if (call.name === 'edit') {
    const args = call.arguments ?? {};
    const sharedPath = String(args.path ?? args.file_path ?? args.file ?? '');
    const edits = Array.isArray(args.edits) ? args.edits : [args];
    for (const entry of edits as Array<{ path?: string; file_path?: string; oldText?: string; newText?: string }>) {
      const target = String(entry?.path ?? entry?.file_path ?? sharedPath);
      findings.push(...checkTextChange(target, String(entry?.oldText ?? ''), String(entry?.newText ?? ''), extra));
    }
  } else if (call.name === 'write') {
    const args = call.arguments ?? {};
    const target = String(args.path ?? args.file_path ?? args.file ?? '');
    findings.push(...checkTextChange(target, '', String(args.content ?? ''), extra));
  } else if (call.name === 'bash') {
    findings.push(...checkBash(String(call.arguments?.command ?? ''), extra));
  }

  const unique = dedupeFindings(findings);
  return disabled ? unique.filter(f => !disabled.has(f.kind)) : unique;
}

function formatRefusal(findings: WeakeningFinding[]): string {
  const summary = findings.map(f => `${f.target}: ${f.detail} [${f.kind}]`).join('; ');
  return `Não executado: a alteração afrouxa verificações (${summary}). Corrija o código em vez de afrouxar a checagem; se a mudança for intencional, repita a chamada idêntica ou defina OPTCHAT_CONFIG_PROTECT=off.`;
}

/** Refuses a check-weakening edit, write, or bash call once per identical call; identical retry or `OPTCHAT_CONFIG_PROTECT=off` passes. */
export function configProtectGuard(options: ConfigProtectOptions = {}) {
  const refused = new Set<string>();
  const env = options.env ?? process.env;
  return {
    check(call: ToolUse): string | undefined {
      if (env.OPTCHAT_CONFIG_PROTECT === 'off') return undefined;
      const findings = detectConfigWeakening(call, options);
      if (!findings.length) return undefined;
      const key = JSON.stringify([call.name, call.arguments]);
      if (refused.has(key)) return undefined;
      refused.add(key);
      return formatRefusal(findings);
    },
  };
}

/** Registers the config-protect guard on Pi's `tool_call` hook unless `OPTCHAT_CONFIG_PROTECT=off`. */
export function registerConfigProtectGuard(pi: Hooks, options: ConfigProtectOptions = {}) {
  const env = options.env ?? process.env;
  if (env.OPTCHAT_CONFIG_PROTECT === 'off') return;
  const guard = configProtectGuard(options);
  pi.on('tool_call', (event: { toolName: string; input: Record<string, unknown> }) => {
    const reason = guard.check({ name: event.toolName, arguments: event.input });
    return reason ? { block: true, reason } : undefined;
  });
}
