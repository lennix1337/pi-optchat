import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { decide, parseContract, type Repo } from '../src/autonomy.ts';
import { PROTECTED_ACTIONS } from '../src/autonomy-self-edit.ts';
import { registerEffectApprovals } from '../src/authorization-hooks.ts';
import { retroPrompt } from '../src/daily-retro.ts';
import { heartbeatCommand } from '../src/heartbeat-report.ts';
import { defaults, loadConfig } from '../src/profiles.ts';
import { composeSummary, localInputs } from '../src/slack-reports.ts';
import {
  applyPromotion,
  DEFAULT_PROMOTION_THRESHOLD,
  DEFAULT_WINDOW_DAYS,
  demoteContract,
  formatProposalLine,
  isProtectedAction,
  ladderProposalLines,
  promotionProposals,
  readAutonomyLog,
  readPromotionProposals,
  recordAutonomyOutcome,
  tallyAutonomyLog,
  type LadderLogEntry,
} from '../src/autonomy-ladder.ts';

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-20T12:00:00Z');
const entry = (overrides: Partial<LadderLogEntry> & { action: string }): LadderLogEntry => ({
  at: NOW - DAY,
  targets: ['acme/app'],
  summary: 'sample action',
  ...overrides,
});

const tempDir = () => mkdtempSync(join(tmpdir(), 'autonomy-ladder-'));

test('counts operator approvals vs overrides/denials per action class within the 30-day window', () => {
  const entries: LadderLogEntry[] = [
    entry({ action: 'merge', outcome: 'approved', at: NOW - 1 * DAY }),
    entry({ action: 'merge', outcome: 'approved', at: NOW - 29 * DAY }),
    entry({ action: 'merge', outcome: 'approved', at: NOW - 31 * DAY }),
    entry({ action: 'merge', outcome: 'approved', at: NOW + 1000 }),
    entry({ action: 'merge', at: NOW - 2 * DAY }),
    entry({ action: 'merge', outcome: 'reported', at: NOW - 2 * DAY }),
    entry({ action: 'merge', outcome: 'demoted', at: NOW - 2 * DAY }),
    entry({ action: 'discard', outcome: 'approved', at: NOW - 1 * DAY }),
    entry({ action: 'discard', outcome: 'denied', at: NOW - 2 * DAY }),
    entry({ action: 'discard', outcome: 'override', at: NOW - 3 * DAY }),
    entry({ action: 'constructor', outcome: 'approved', at: NOW - 1 * DAY }),
    entry({ action: '__proto__', outcome: 'denied', at: NOW - 1 * DAY }),
  ];
  const counts = tallyAutonomyLog(entries, { now: NOW });
  assert.equal(counts.get('merge')?.approvals, 2);
  assert.equal(counts.get('merge')?.overrides, 0);
  assert.equal(counts.get('merge')?.reported, 2);
  assert.equal(counts.get('discard')?.approvals, 1);
  assert.equal(counts.get('discard')?.overrides, 2);
  assert.equal(counts.get('constructor')?.approvals, 1);
  assert.equal(counts.get('__proto__')?.overrides, 1);
});

test('emits a promotion proposal (ask -> report) only after K clean approvals with zero overrides in 30 days', () => {
  assert.equal(DEFAULT_PROMOTION_THRESHOLD, 5);
  assert.equal(DEFAULT_WINDOW_DAYS, 30);
  const contract = parseContract({
    version: 1,
    default: 'report',
    rules: [
      { action: 'merge', scope: ['*'], level: 'ask' },
      { action: 'push', scope: ['*'], level: 'report' },
      { action: 'discard', scope: ['*'], level: 'ask' },
      { action: 'process-kill', scope: ['*'], level: 'ask' },
    ],
  });

  const fourApprovals = Array.from({ length: 4 }, (_, i) => entry({ action: 'merge', outcome: 'approved', at: NOW - (i + 1) * DAY }));
  assert.deepEqual(promotionProposals(fourApprovals, { contract, now: NOW }), []);

  const fiveApprovals = [...fourApprovals, entry({ action: 'merge', outcome: 'approved', at: NOW - 5 * DAY })];
  const proposals = promotionProposals(fiveApprovals, { contract, now: NOW });
  assert.equal(proposals.length, 1);
  assert.deepEqual(proposals[0], {
    action: 'merge',
    from: 'ask',
    to: 'report',
    approvals: 5,
    overrides: 0,
    windowDays: 30,
    threshold: 5,
    lastApprovalAt: NOW - DAY,
  });
  assert.match(formatProposalLine(proposals[0]!), /PROMOTION PROPOSAL.*merge.*ask -> act\+notify/i);

  const custom = promotionProposals(fourApprovals, { contract, now: NOW, threshold: 4 });
  assert.equal(custom.length, 1);
  assert.equal(custom[0]?.action, 'merge');

  const withRecentOverride = [...fiveApprovals, entry({ action: 'merge', outcome: 'denied', at: NOW - 20 * DAY })];
  assert.deepEqual(promotionProposals(withRecentOverride, { contract, now: NOW }), []);

  const withOldOverride = [...fiveApprovals, entry({ action: 'merge', outcome: 'override', at: NOW - 31 * DAY })];
  assert.equal(promotionProposals(withOldOverride, { contract, now: NOW }).length, 1);

  const alreadyReport = Array.from({ length: 6 }, (_, i) => entry({ action: 'push', outcome: 'approved', at: NOW - (i + 1) * DAY }));
  assert.deepEqual(promotionProposals(alreadyReport, { contract, now: NOW }), []);
});

test('protected classes and account/credential changes are never proposed for promotion', () => {
  const contract = parseContract({ version: 1, default: 'ask', rules: [] });
  const forbidden = [
    ...PROTECTED_ACTIONS,
    'database-destructive',
    'account-change',
    'credential-change',
    'contract-self-edit',
    'unclassified',
    '*',
  ];
  const entries: LadderLogEntry[] = [];
  for (const action of forbidden) {
    assert.equal(isProtectedAction(action), true, action);
    for (let i = 0; i < 10; i++) entries.push(entry({ action, outcome: 'approved', at: NOW - (i + 1) * 3_600_000 }));
  }
  entries.push(...Array.from({ length: 5 }, (_, i) => entry({ action: 'recursive-delete', outcome: 'approved', at: NOW - (i + 1) * 3_600_000 })));

  const proposals = promotionProposals(entries, { contract, now: NOW });
  assert.deepEqual(proposals.map(p => p.action), ['recursive-delete']);
});

test('automatic demotion steps down immediately on operator override or denial and preserves protected rules', () => {
  const base = parseContract({
    version: 1,
    default: 'report',
    rules: [
      { action: 'deploy', scope: ['*'], level: 'ask' },
      { action: 'push', scope: ['*'], level: 'free' },
      { action: 'merge', scope: ['*'], level: 'report' },
      { action: 'discard', scope: ['*'], level: 'ask' },
    ],
  });

  const demotedMerge = demoteContract(base, 'merge', NOW);
  assert.equal(demotedMerge.changed, true);
  assert.equal(demotedMerge.from, 'report');
  assert.equal(demotedMerge.to, 'ask');
  assert.equal(decide(demotedMerge.contract, [{ action: 'merge', targets: ['acme/app'] }], NOW).level, 'ask');
  assert.equal(decide(demotedMerge.contract, [{ action: 'deploy', targets: ['acme/app'] }], NOW).level, 'ask');

  const demotedPushOnce = demoteContract(base, 'push', NOW);
  assert.equal(demotedPushOnce.changed, true);
  assert.equal(demotedPushOnce.from, 'free');
  assert.equal(demotedPushOnce.to, 'report');
  assert.equal(decide(demotedPushOnce.contract, [{ action: 'push', targets: ['acme/app'] }], NOW).level, 'report');

  const demotedPushTwice = demoteContract(demotedPushOnce.contract, 'push', NOW);
  assert.equal(demotedPushTwice.changed, true);
  assert.equal(demotedPushTwice.from, 'report');
  assert.equal(demotedPushTwice.to, 'ask');
  assert.equal(decide(demotedPushTwice.contract, [{ action: 'push', targets: ['acme/app'] }], NOW).level, 'ask');

  const alreadyAsk = demoteContract(base, 'discard', NOW);
  assert.equal(alreadyAsk.changed, false);

  const unruled = demoteContract(parseContract({ version: 1, default: 'report', rules: [] }), 'recursive-delete', NOW);
  assert.equal(unruled.changed, true);
  assert.equal(decide(unruled.contract, [{ action: 'recursive-delete', targets: ['/repo/build'] }], NOW).level, 'ask');

  const withWildcard = demoteContract(parseContract({
    version: 1,
    default: 'report',
    rules: [{ action: '*', scope: ['*'], level: 'report' }],
  }), 'process-kill', NOW);
  assert.equal(withWildcard.changed, true);
  assert.equal(decide(withWildcard.contract, [{ action: 'process-kill', targets: ['pid:123'] }], NOW).level, 'ask');
  assert.equal(withWildcard.contract.rules.at(-1)?.action, '*');
});

test('promotions are never applied without interactive operator approval, while denials demote immediately on disk', () => {
  const dir = tempDir();
  try {
    const file = join(dir, 'autonomy.json');
    const initial = {
      version: 1,
      default: 'report',
      rules: [
        { action: 'merge', scope: ['*'], level: 'ask' },
        { action: 'push-main', scope: ['*'], level: 'report' },
        { action: 'deploy', scope: ['*'], level: 'ask' },
      ],
    };
    writeFileSync(file, JSON.stringify(initial, null, 2));

    for (let i = 0; i < 6; i++) {
      const res = recordAutonomyOutcome(dir, {
        at: NOW - (6 - i) * DAY,
        action: 'merge',
        targets: ['acme/app'],
        summary: `gh pr merge ${i + 1}`,
        outcome: 'approved',
      });
      assert.equal(res.demoted, false);
    }
    assert.equal(decide(parseContract(JSON.parse(readFileSync(file, 'utf8'))), [{ action: 'merge', targets: ['acme/app'] }], NOW).level, 'ask');
    assert.deepEqual(readPromotionProposals(dir, { now: NOW }).map(p => p.action), ['merge']);

    for (const source of ['extension', 'rpc', 'wake', 'retro']) {
      const refused = applyPromotion(dir, 'merge', source, NOW);
      assert.equal(refused.applied, false);
    }
    assert.equal(applyPromotion(dir, 'deploy', 'interactive', NOW).applied, false);
    assert.equal(decide(parseContract(JSON.parse(readFileSync(file, 'utf8'))), [{ action: 'merge', targets: ['acme/app'] }], NOW).level, 'ask');

    const promoted = applyPromotion(dir, 'merge', 'interactive', NOW);
    assert.equal(promoted.applied, true);
    assert.equal(decide(parseContract(JSON.parse(readFileSync(file, 'utf8'))), [{ action: 'merge', targets: ['acme/app'] }], NOW).level, 'report');
    assert.deepEqual(readPromotionProposals(dir, { now: NOW }), []);

    const demoted = recordAutonomyOutcome(dir, {
      at: NOW,
      action: 'push-main',
      targets: ['acme/app'],
      summary: 'git push origin main',
      outcome: 'override',
    });
    assert.equal(demoted.demoted, true);
    assert.equal(decide(parseContract(JSON.parse(readFileSync(file, 'utf8'))), [{ action: 'push-main', targets: ['acme/app'] }], NOW).level, 'ask');
    assert.ok(readAutonomyLog(dir).some(row => row.action === 'push-main' && row.outcome === 'demoted'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('gate hooks log operator approvals without auto-promoting and demote immediately on operator denial', async () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, 'autonomy.json'), JSON.stringify({
      version: 1,
      default: 'report',
      rules: [
        { action: 'merge', scope: ['acme/*'], level: 'ask' },
        { action: 'push', scope: ['acme/*'], level: 'free' },
        { action: 'push', scope: ['other/*'], level: 'ask' },
      ],
    }, null, 2));

    const repo: Repo = {
      slug: path => path.includes('other') ? 'other/lib' : 'acme/app',
      branch: () => 'feat/x',
    };
    const hooks = new Map<string, (...args: any[]) => any>();
    const pi = { on(name: string, fn: (...args: any[]) => any) { hooks.set(name, fn); } } as unknown as ExtensionAPI;
    registerEffectApprovals(pi, { enabled: true, mode: 'risk', bell: () => {}, repo, contractDir: () => dir });
    const ctx = (cwd: string) => ({
      cwd,
      sessionManager: { getSessionId: () => 'owner', getBranch: () => [] },
      ui: { notify() {}, setWidget() {} },
    });

    for (let i = 1; i <= 5; i++) {
      const event = { toolName: 'bash', toolCallId: `m${i}`, input: { command: `gh pr merge ${i} --repo acme/app --squash` } };
      const blocked = await hooks.get('tool_call')!(event, ctx('C:/repos/app'));
      assert.equal(blocked?.block, true);
      await hooks.get('input')!({ text: '/approve', source: 'interactive' }, ctx('C:/repos/app'));
      assert.equal(await hooks.get('tool_call')!(event, ctx('C:/repos/app')), undefined);
    }

    assert.deepEqual(readPromotionProposals(dir).map(p => p.action), ['merge']);
    const sixth = await hooks.get('tool_call')!({ toolName: 'bash', toolCallId: 'm6', input: { command: 'gh pr merge 6 --repo acme/app --squash' } }, ctx('C:/repos/app'));
    assert.equal(sixth?.block, true);

    assert.equal(await hooks.get('tool_call')!({ toolName: 'bash', toolCallId: 'p1', input: { command: 'git push origin feat/x' } }, ctx('C:/repos/app')), undefined);

    const pushBlocked = await hooks.get('tool_call')!({ toolName: 'bash', toolCallId: 'p2', input: { command: 'git push origin feat/x' } }, ctx('C:/repos/other'));
    assert.equal(pushBlocked?.block, true);
    await hooks.get('input')!({ text: '/deny', source: 'interactive' }, ctx('C:/repos/other'));

    const updated = parseContract(JSON.parse(readFileSync(join(dir, 'autonomy.json'), 'utf8')));
    assert.equal(decide(updated, [{ action: 'push', targets: ['acme/app'] }]).level, 'report');
    const logAfter = readAutonomyLog(dir);
    assert.equal(logAfter.filter(e => e.action === 'merge' && e.outcome === 'approved').length, 5);
    assert.equal(logAfter.filter(e => e.action === 'push' && e.outcome === 'denied').length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('proposals surface in retroPrompt, /heartbeat report, and morning briefing without changing empty output', () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, 'autonomy.json'), JSON.stringify({
      version: 1,
      default: 'report',
      rules: [{ action: 'merge', scope: ['*'], level: 'ask' }],
    }));

    assert.deepEqual(ladderProposalLines(dir, NOW), []);
    assert.doesNotMatch(retroPrompt('2026-11-20', [], undefined, ladderProposalLines(dir, NOW)), /PROMOTION PROPOSAL/);
    assert.doesNotMatch(heartbeatCommand('report', { dir, now: NOW, cap: 6, minutes: 30 }), /PROMOTION PROPOSAL/);

    for (let i = 0; i < 5; i++) {
      recordAutonomyOutcome(dir, {
        at: NOW - (i + 1) * DAY,
        action: 'merge',
        targets: ['acme/app'],
        summary: `gh pr merge ${i + 1}`,
        outcome: 'approved',
      });
    }

    const lines = ladderProposalLines(dir, NOW);
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /PROMOTION PROPOSAL: merge \(ask -> act\+notify/);

    const retro = retroPrompt('2026-11-20', [], undefined, lines);
    assert.match(retro, /PROMOTION PROPOSAL: merge/);
    assert.match(retro, /NEVER apply without explicit operator approval/i);

    const hb = heartbeatCommand('report', { dir, now: NOW, cap: 6, minutes: 30 });
    assert.match(hb, /PROMOTION PROPOSAL: merge/);

    const summary = composeSummary({ ...localInputs(dir, NOW, []), waiting: [], approvals: 0 });
    assert.match(summary, /PROMOTION PROPOSAL: merge/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('profile config validates autonomyLadder settings and keeps neutral defaults', () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      compactor: defaults.compactor,
      subagent: defaults.subagent,
      autonomyLadder: { promotionThreshold: 7, windowDays: 14 },
    }));
    assert.deepEqual(loadConfig(dir).autonomyLadder, { promotionThreshold: 7, windowDays: 14 });

    for (const bad of [{ promotionThreshold: 0 }, { promotionThreshold: 2.5 }, { windowDays: -1 }, 'fast']) {
      writeFileSync(join(dir, 'config.json'), JSON.stringify({
        compactor: defaults.compactor,
        subagent: defaults.subagent,
        autonomyLadder: bad,
      }));
      assert.throws(() => loadConfig(dir), /autonomyLadder/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('corrupt autonomy.json fails closed without overwriting, and contract report runs never count as operator approvals', async () => {
  const dir = tempDir();
  try {
    const file = join(dir, 'autonomy.json');
    const broken = '{ "version": 1, "rules": [';
    writeFileSync(file, broken);
    const denial = recordAutonomyOutcome(dir, { at: NOW, action: 'merge', targets: ['acme/app'], summary: 'merge', outcome: 'denied' });
    assert.equal(denial.demoted, false);
    assert.ok(denial.error);
    assert.equal(readFileSync(file, 'utf8'), broken);
    assert.deepEqual(readPromotionProposals(dir, { now: NOW }), []);
    assert.equal(applyPromotion(dir, 'merge', 'interactive', NOW).applied, false);

    writeFileSync(file, JSON.stringify({
      version: 1,
      default: 'report',
      rules: [{ action: 'push-main', scope: ['*'], level: 'report' }],
    }));
    const repo: Repo = { slug: () => 'acme/app', branch: () => 'main' };
    const hooks = new Map<string, (...args: any[]) => any>();
    const pi = { on(name: string, fn: (...args: any[]) => any) { hooks.set(name, fn); } } as unknown as ExtensionAPI;
    registerEffectApprovals(pi, { enabled: true, mode: 'risk', bell: () => {}, repo, contractDir: () => dir });
    const ctx = { cwd: 'C:/repos/app', sessionManager: { getSessionId: () => 'owner', getBranch: () => [] }, ui: { notify() {}, setWidget() {} } };
    for (let i = 0; i < 6; i++) {
      assert.equal(await hooks.get('tool_call')!({ toolName: 'bash', toolCallId: `r${i}`, input: { command: 'git push origin main' } }, ctx), undefined);
    }
    const tally = tallyAutonomyLog(readAutonomyLog(dir), { now: Date.now() + 1000 });
    assert.equal(tally.get('push-main')?.approvals ?? 0, 0);
    assert.equal(tally.get('push-main')?.reported, 6);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
