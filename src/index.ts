import { WakeWorkers, WORKER_RECOVERY, WORKER_UNVERIFIED } from './wake-workers.ts';
import { registerAssistant } from './assistant-client.ts';
import { registerAssistantMemory } from './assistant-memory.ts';
import { registerSlackBridge } from './slack-bridge.ts';
import { NO_WORK, readHomeWork, readWatch, stillWaiting } from './home-items.ts';
import { registerWorkTracker } from './work-tracker.ts';
import { registerLiveResources } from './live-resources.ts';
import { registerToolInventory } from './tool-inventory.ts';
import { readManyTool } from './read-many.ts';
import { logSent, registerSlackReports } from './slack-reports.ts';
import { registerProdHealth } from './prod-health.ts';
import { cachedEconomy } from './quota-load.ts';
import { registerQuotaCommand } from './quota-command.ts';
import { projectLocalInbox } from './assistant-projection.ts';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { getCurrentSystemMessage, getSupportedThinkingLevels, type Api, type Model } from '@earendil-works/pi-ai';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { getAgentDir, parseSkillBlock, type ExtensionAPI, type ExtensionContext, type ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { DEFER, Memory } from './memory.ts';
import { Focus } from './focus.ts';
import { atomicWrite, readJsonOr, storeFor } from './store.ts';
import { QUOTA_FILE, quotaPlan, routeBlock } from './quota-health.ts';
import { QuotaOutage } from './quota-hold.ts';
import { REPORT_GATHER_MS, ReportDispatcher } from './report-dispatch.ts';
import { packReports } from './report-bundle.ts';
import { knownProviders, pickWakeRoute } from './wake-route.ts';
import { createCompressor, resolveModel } from './compactor.ts';
import { writeCacheDiagnostic, writeCompactorDiagnostic, writeRecoveryDiagnostic, sanitizeRecoveryDiagnostic } from './compactor-diagnostics.ts';
import { createProfile, dataHome, holdProfile, instructions, isWindows, lastProfile, listProfiles, loadConfig, modelFor, profilePath, rememberProfile, roleModel, saveConfig, wakeModelFor, wakeRoutes, ProfileBusyError, type MainModel, type ProfileConfig } from './profiles.ts';
import { PROMPT } from './recipe-prompt.ts';
import { allowSearch, CONTINUITY, IMPORT_GUIDANCE, NAVIGATION_DOC, SEARCH_DOC, TURN_REFRESHED } from './prompts.ts';
import { cachePayload, coldAfter, prefixRetention, record, ViewEntries } from './cache.ts';
import { nativeHead, StableHead, type SavedHead } from './stable-head.ts';
import { saveImages } from './images.ts';
import { wakeOff, wakeOn, type WakeHost } from './wake-model.ts';
import { quietGhTelemetry } from './gh-quiet.ts';
import { basicPythonRepl } from './python-repl.ts';
import { reportsBlockReload } from './pending-reports.ts';
import { asUser, boundedMessage, atWork, budgetContext, buildContext, coldBudget, logMessage, messageChars, previousExchange, refreshedRun, refreshBudget, refreshFraction, refreshPoint, refreshTokens, lastStep, reportReceipt, REPORT_RECEIPT, REPORT_TYPE, RUN_BOUNDARY, stateless, textContent, typedText } from './transcript.ts';
import { assertContextFits, inputTokenBudget } from './run-context.ts';
import { registerReportRenderer, type ReportDetails } from './report-message.ts';
import { memoryTools, result, searchTool } from './tools.ts';
import { Children, loadedBuiltins } from './agents.ts';
import { childToolSchemas } from './child-resources.ts';
import { isActiveRun, type RunInfo } from './runs.ts';
import { exportBrowser } from './browser.ts';
import { registerWhatsAppBridge } from './whatsapp-bridge.ts';
import { Inbox } from './inbox.ts';
import { OperationJournal, registerOperationSafety } from './operations.ts';
import { registerBashHints } from './bash-hints.ts';
import { DeployWatch, registerDeployGuard, workerHooks } from './deploy.ts';
import { registerReadChainHint } from './read-chain.ts';
import { Crew, MANAGER_DOC, crewTool, crewWakeNote, pauseOnApiKey, registerDelegationNudge, routeFor } from './crew.ts';
import { lastRunsOf } from './wake-signals.ts';
import { createPatrol, escalationNote } from './patrol.ts';
import { registerPowerShellQuotingGuard } from './powershell-quoting.ts';
import { registerBashTimezoneGuard } from './bash-timezone.ts';
import { registerRecursiveGrepNarrowing } from './bash-recursive-grep.ts';
import { registerCommitHookGuard } from './commit-hook-guard.ts';
import { registerMergeCiGuard } from './merge-ci-guard.ts';
import { registerBrowserPages } from './external-effects.ts';
import { registerEffectApprovals } from './authorization-hooks.ts';
import { adviseEffect } from './effect-advisor.ts';
import { Heartbeat, beatSnapshot, checkBeat, heartbeatPlan, previousWake, runRadarFresh, signalWakeText, wakeText, wakeTurn } from './heartbeat.ts';
import { nextQueueItem, queueFile } from './heartbeat-queue.ts';
import { DayFrozenLessons, morningSummary } from './dream-lessons.ts';
import { heartbeatCommand, summarizeTurn, wakeRetry } from './heartbeat-report.ts';
import { catchupSource, registerCatchup } from './catchup-integration.ts';
import { describeGrant, grantTargets, orderGrantFor, readOperationalState, renderOperationalContext } from './operational-state.ts';
import { operationalStateTool } from './operational-tool.ts';
import { openTaskOrders, readCommitments, registerCommitments, waitingItems } from './commitments.ts';
import { latestOperatorMessage } from './operator-words.ts';
import { registerCorrections } from './corrections.ts';
import { SKILL_INVOCATION_TYPE, skillInvocationNote } from './skill-invocation.ts';
import { cleanClosedOnce, closedConflictsOf } from './closed-conflicts.ts';
import { retrySummary } from './summary-retry.ts';
import { checkpoint } from './checkpoint.ts';
import { memoryDirectory, pendingImport, prepareImport, runImport, discardImport } from './import/job.ts';
import { chooseImport, showProgress } from './import/ui.ts';
import { UsageLedger } from './usage.ts';
import { oneLine, showInspector, type InspectorPage } from './inspector.ts';
import { showAgentView } from './agent-view.ts';
import { ShellJobs, adoptShells, handOffShells, longCommandMover, registerShells, runningShells, shellReporter } from './shells.ts';
import { ROUTER_DOC, syncRouterTools } from './router-mode.ts';
import { recordShellOutcome } from './journal-spool.ts';
import { registerReapingBash } from './shell-reaper.ts';
import { inspectorShortcut, mountNavigation, mountWaitingBoard } from './navigation.ts';
import { WaitingBoard } from './waiting-board.ts';
import { joinHeadless, listAttachableAgents, serveWindows } from './window-bridge.ts';
import { openConnectedWindow, registerConnectedRenderer } from './connected-window.ts';
import { createHandoffSummarizer } from './handoff.ts';
import { mainTitle, TabTitle } from './title.ts';
import { showFallbacks, showModelPicker, showSettings } from './settings-page.ts';
import { showMenu } from './menu.ts';
import { Sync } from './sync.ts';
import { OutputStore } from './output-store.ts';
import { OutputContext, outputReadTool } from './output-context.ts';
import { PerformanceMetrics, registerPerformance, performanceTool } from './performance.ts';
import { heapReportTool, noteReload, reloadCount } from './heap-report.ts';
import { registerExecLog } from './exec-log.ts';
import { profilePhase, type ProfilePhase } from './profile-phase.ts';
import { HOLD_MAX_MS, RELOAD_RESUME, registerSelfReload, reloadLease } from './self-reload.ts';
import { markRetro, retroDue, retroPrompt } from './daily-retro.ts';
import { MachineService, machineService, machineTool } from './machine-service.ts';
import { Collector, Situation } from './situation.ts';
import { realSources } from './situation-sources.ts';

const binding = 'optchat.profile';
/** The request head the prompt cache holds (StableHead) is kept in `HEAD_FILE` of the profile, keyed by session, so /reload sends it again.
 * Sessions written before that hold it as custom entries of this type: the last one is read when the file is not the session's. */
const HEAD_ENTRY = 'optchat.head';
const HEAD_FILE = 'head.json';
const VIEW_ENTRIES_FILE = 'cache-entries.json';
const CONNECT_MODES = ['auto', 'join', 'off'] as const;
/** Print mode routes `process.stdout` to stderr so only the answer reaches stdout; the joined reply goes to fd 1 itself. */
async function printReply(text: string) {
  const bytes = Buffer.from(`${text}\n`);
  for (let at = 0; at < bytes.length;) {
    try { at += writeSync(1, bytes, at); }
    catch (error) { if (!record(error) || error.code !== 'EAGAIN') throw error; await new Promise(resolve => setTimeout(resolve, 10)); }
  }
}
function readHeadFile(dir: string, sessionId: string): unknown {
  try {
    const saved = JSON.parse(readFileSync(join(dir, HEAD_FILE), 'utf8')) as { sessionId?: unknown; head?: unknown } | null;
    return saved?.sessionId === sessionId ? saved.head : undefined;
  } catch { return undefined; }
}
function writeHeadFile(dir: string, sessionId: string, head: SavedHead) {
  try { atomicWrite(join(dir, HEAD_FILE), JSON.stringify({ sessionId, head })); }
  catch { console.error(`OptChat could not write ${HEAD_FILE}; after /reload the request head is built again.`); }
}
const toggle = (prompt: string, line: string, on: boolean, after: string) => on === prompt.includes(line) ? prompt : on ? prompt.replace(after, after + line) : prompt.replace(line, '');
/** A report run while idle reuses the last built prompt, so Previous exchange and Memory search changes since then are applied here. */
const promptFor = (prompt: string, { previousExchange, memorySearch }: ProfileConfig) =>
  allowSearch(toggle(toggle(prompt, CONTINUITY, previousExchange, PROMPT), SEARCH_DOC, memorySearch, previousExchange ? PROMPT + CONTINUITY : PROMPT), memorySearch);
interface Active { name: string; dir: string; config: ProfileConfig; memory: Memory; focus: Focus; inbox: Inbox; children: Children; crew: Crew; usage: UsageLedger; operations: OperationJournal; sessionId: string; sync: Sync; outputs: OutputContext; metrics: PerformanceMetrics; unlock: () => Promise<void> }

/** OptChat's own version, read from the package.json beside src/ (in the checkout and the npm package alike); none if unreadable. */
export const version = ((): string | undefined => {
  try {
    const data: unknown = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    return data && typeof data === 'object' && 'version' in data && typeof data.version === 'string' ? data.version : undefined;
  } catch { return undefined; }
})();
const brand = version ? `OptChat v${version}` : 'OptChat';

export default function optchat(pi: ExtensionAPI) {
  quietGhTelemetry();
  basicPythonRepl();
  // Shells a /reload handed over keep running under the same IDs; another profile opening first stops them.
  const adopted = adoptShells();
  const shells = adopted?.jobs ?? new ShellJobs();
  let adoptedProfile = adopted?.profile;
  // A bash call expected to run long starts as a background shell instead of holding the turn (long-commands.ts).
  const canStartShell = () => { required(); if (stopping) throw new Error('Profile is closing'); };
  const shellSettings = { notifyDefault: () => active?.config.shellNotify ?? 'end' };
  registerReapingBash(pi, longCommandMover(shells, shellSettings, () => active !== undefined && !stopping));
  registerShells(pi, shells, canStartShell, shellSettings);
  let active: Active | undefined;
  // A background shell's end becomes an outcome even when its notify mode hides it from the model: exit code, latency and
  // zero model calls, never the command's text in a notification. Foreground bash is Pi's own result, not a managed job.
  shells.setEndObserver(job => { const current = active; if (!current || stopping) return; recordShellOutcome(current.dir, current.sessionId, job); });
  registerExecLog(pi, () => active?.dir);
  registerPerformance(pi, () => active?.metrics, (timestamp, latency) => active?.usage.timing(timestamp, latency));
  const recoveryIncidents = new Map<string, string>();
  const recoveryEvent = (event: unknown) => {
    const diagnostic = sanitizeRecoveryDiagnostic(event);
    if (!active || !diagnostic) return;
    const sessionId = diagnostic.sessionId ?? active.sessionId;
    if (!/^[a-f0-9-]{36}$/i.test(diagnostic.incidentId)) return;
    if (diagnostic.phase === 'started' || diagnostic.phase === 'recovering') recoveryIncidents.set(sessionId, diagnostic.incidentId);
    else if (recoveryIncidents.get(sessionId) === diagnostic.incidentId) recoveryIncidents.delete(sessionId);
    try { writeRecoveryDiagnostic(active.dir, { ...diagnostic, sessionId }); }
    catch { console.error('OptChat could not persist recovery diagnostics; incident metadata may be incomplete. Recovery decisions are unchanged.'); }
  };
  const unsubscribeRecovery = pi.events.on('optchat:recovery', recoveryEvent);
  // First: a PowerShell script bash would rewrite (`$_` inside double quotes) is refused before it runs, so it needs no
  // approval and leaves no operation to journal. A foreground wait is not refused: the bash mover runs it as a shell (shells.ts).
  registerPowerShellQuotingGuard(pi);
  registerBashTimezoneGuard(pi);
  registerRecursiveGrepNarrowing(pi);
  // Likewise a commit whose pre-commit hook would outlive a short bash timeout: refused before it runs, no approval needed.
  registerCommitHookGuard(pi);
  // And a direct `gh pr merge` over failing, pending or unreadable CI (src/merge-ci-guard.ts); the profile's local-gate
  // verdicts cover checks GitHub never started.
  registerMergeCiGuard(pi, { dir: () => active && join(active.dir, 'local-gate') });
  // Each owned browser tab's last page, so input on a consent, account or billing page waits for the operator.
  registerBrowserPages(pi);
  // Risky calls go first to the profile's cheap compactor model (Haiku on Claude, gpt-6-luna on Codex), thinking off.
  const approvals = registerEffectApprovals(pi, { advisor: (request, ctx) => {
    const profile = active;
    if (!profile) return Promise.reject(new Error('no OptChat profile is open'));
    let grants: string[] = [];
    try {
      const line = describeGrant(readOperationalState(join(profile.dir, 'operational-state.json')), request.kind, request.input, grantTargets(request.input, request.cwd));
      if (line) grants = [line];
    } catch { /* an unreadable state file must not block the advisor; the operator still decides */ }
    let tasks: string[] = [];
    try { tasks = openTaskOrders(readCommitments(profile.dir), id => profile.memory.root[Number(id)]); }
    catch { /* no commitments file: the recent messages alone decide */ }
    return adviseEffect(ctx.modelRegistry, modelFor(profile.config, 'compactor', main), { ...request, grants, tasks },
      message => profile.usage.compression(message, 'advisor', profile.sessionId));
  }, contractDir: () => active?.dir,
  // "pode fazer o merge e o deploy", recorded as grants quoting it, covers the calls it names instead of one prompt each.
  orderGrant: effect => {
    const profile = active;
    if (!profile) return undefined;
    const said = (id: string) => {
      const source = /^(0|[1-9]\d*)$/.test(id) ? profile.memory.root[Number(id)] : undefined;
      return source?.kind === 'user' && !source.origin ? source.text : undefined;
    };
    try { return orderGrantFor(readOperationalState(join(profile.dir, 'operational-state.json')), effect, said); }
    catch { return undefined; /* an unreadable state file lifts nothing: the call waits for the operator */ }
  },
  // A call that waits for the operator is also posted to their Slack DM, where its buttons or `aprovar`/`negar` in its
  // thread decide it; decided anywhere else, the post is rewritten to say so.
  onPending: (pending, session, gate) => void slack.askApproval({ token: pending.token, summary: pending.summary, label: pending.kind ?? pending.tool, expires: pending.expires,
    decide: approve => gate.decideFromPhone(session, pending.token, approve) }),
  onSettled: (token, outcome) => void slack.settled(token, outcome) });
  registerOperationSafety(pi, () => active?.operations, sessionId => recoveryIncidents.get(sessionId));
  registerBashHints(pi); // After the safety hooks: they must classify the unmodified result.
  // A production deploy in flight (src/deploy.ts): the delegation reminder is quiet, launches are refused, running workers hold heavy work.
  const deploy = new DeployWatch({ shells: () => runningShells(shells), extra: () => active?.config.deployCommands ?? [] }, workerHooks(() => active?.children));
  registerDeployGuard(pi, deploy, listener => shells.subscribe(listener));
  registerDelegationNudge(pi, () => active?.config.delegateAfter ?? 0, () => active?.config.managerMode === true, () => deploy.quiet());
  registerReadChainHint(pi); // Lone read after lone read: batch the independent ones (src/read-chain.ts). Workers load no extension, so only this session gets it.
  let main: MainModel | undefined; // The main model each role's model follows, see modelFor.
  let remote: Awaited<ReturnType<typeof openConnectedWindow>> | undefined;
  /** `pi -p` on a profile another Pi owns: the prompt goes to a subagent in that Pi (--optchat-connect). */
  let joined: Awaited<ReturnType<typeof joinHeadless>> | undefined;
  let closeWindows: (() => Promise<void>) | undefined;
  let recovery: Promise<void> | undefined;
  let run: AgentMessage[] = [];
  let previous: AgentMessage[] = [];
  let logged = 0;
  /** After a mid-turn refresh (#146), the run is sent from here on, after its task; 0 sends it whole. */
  let keep = 0;
  let view: string | undefined;
  // Like the chronological view, focus is frozen between turn/refresh boundaries for cache stability.
  let focusView: string | undefined;
  /** When this profile last sent the main model a request: a turn starting long after it may merge the view (DEFER). */
  let lastRequestAt: number | undefined;
  /** The cache entries the main requests' view marks wrote, and the system head those requests keep (see their modules). */
  const viewEntries = new ViewEntries(undefined, report => {
    if (!active) return;
    writeCacheDiagnostic(active.dir, report);
    try { atomicWrite(join(active.dir, VIEW_ENTRIES_FILE), JSON.stringify(viewEntries.snapshot())); }
    catch { console.error(`OptChat could not write ${VIEW_ENTRIES_FILE}; after /reload the view is written to the cache again.`); }
  }), stableHead = new StableHead();
  let savedHead: SavedHead | undefined;
  /** Counts view captures (turn starts and refreshes): after one, the request is new from the view on. */
  let viewEpoch = 0;
  /** The operational records as rendered at the view's capture. They sit in the message that holds the view, so re-rendering
   * them mid-turn rewrote the turn's whole run; a record made since then is in its operational_state result. */
  let records: { epoch: number; text: string } | undefined;
  /** The situation digest (src/situation.ts) and the run it was last asked for: a run says it once, however often the view is rebuilt. */
  let situation: Situation | undefined;
  let runSeq = 0;
  let prompt = '';
  /** A compaction is a call like a turn (recipe §4): once a turn has built them, it gets the turns' system prompt and tools. */
  const shared = () => {
    if (!active || !prompt) return undefined;
    const on = new Set(pi.getActiveTools());
    return { systemPrompt: stateless(promptFor(prompt, active.config)).prompt,
      tools: pi.getAllTools().filter(tool => on.has(tool.name)).map(({ name, description, parameters }) => ({ name, description, parameters })),
      ...(main ? { model: main } : {}) };
  };
  let runStarted = false;
  let fault: string | undefined;
  /** Reports not yet in memory. `count`: how many subagent reports the text joins. `batch`: held while the rest of that spawn runs, not sent yet.
   * `steered`: last sent into a running turn, where Esc or a dequeue can clear it from Pi's queue unseen. `solo`: always sent as a message of
   * its own. `members`: only on the transient bundle that carries several reports in one message; the reports stay here, each with its own receipt. */
  let reports: { text: string; count?: number; batch?: string; steered?: boolean; sentAt?: number; runIds?: string[]; workerRecovery?: boolean; awaitingProcessing?: boolean; observed?: boolean; responded?: boolean; solo?: boolean; members?: Report[] }[] = [];
  type Report = (typeof reports)[number];
  /** While every model the main agent could run on is out of quota, reports wait here instead of starting turns that would fail (see quota-hold.ts). */
  let outage: QuotaOutage<Report> | undefined;
  /** Sends reports to Pi one turn start at a time (src/report-dispatch.ts). */
  let reportDispatch: ReportDispatcher<Report> | undefined;
  let idle = () => true;
  const receipts = new Map<AgentMessage, string>();
  /** The bundles sent (text -> the reports it carries) and, for a bundle's message in this run, those reports: logged one by one, each under its own receipt. */
  const bundles = new Map<string, Report[]>();
  const BUNDLES_KEPT = 50;
  const bundled = new WeakMap<AgentMessage, Report[]>();
  /** Keep the original result for durable memory; `run` retains the bounded copy sent back to the model. */
  const fullToolResults = new WeakMap<AgentMessage, AgentMessage>();
  let checkpoints = Promise.resolve();
  let importing = false;
  let stopping = false;
  /** Whether the profile is in one of `allowed` phases (src/profile-phase.ts): the one test every feature uses to ask if it may act on the open profile. */
  const inPhase = (...allowed: ProfilePhase[]) => allowed.includes(profilePhase({ active: active !== undefined, remote: remote !== undefined || joined !== undefined,
    stopping, importing, importPending: () => {
      // A journal that cannot be read is an import nobody finished: it keeps the profile paused instead of throwing into a poll or a tool.
      try { return active !== undefined && pendingImport(active.dir) !== undefined; } catch { return true; }
    } }));
  let importController: AbortController | undefined;
  let importTask: Promise<void> | undefined;
  let unmountNavigation: (() => void) | undefined;
  let board: WaitingBoard | undefined;
  let unmountBoard: (() => void) | undefined;
  let inspectorController: AbortController | undefined;
  const shortcut = inspectorShortcut();
  const title = new TabTitle();
  let working = false;
  let untitle: (() => void) | undefined;
  /** Wakes the main agent after a long idle when a cheap check finds work (heartbeatMinutes); interactive owner only. */
  let heartbeat: Heartbeat | undefined;
  let retroTimer: ReturnType<typeof setInterval> | undefined;
  /** The nightly dream's active lessons, frozen for the local day so the system prompt stays cacheable. */
  const dreamLessons = new DayFrozenLessons();
  let settledAt = Date.now();
  /** The open wake was already sent back once for a memory-line reply; a second one settles as it is. */
  let wakeRetried = false;
  const wakeWorkers = new WakeWorkers();
  /** Peer-message copies that arrived while a manager run was in progress (see `peerCopy`). */
  let peerCopies: string[] = [];
  const appendPeerCopies = () => { for (const text of peerCopies.splice(0)) active?.memory.append('work', text); };
  let wakeWorkerTimer: ReturnType<typeof setTimeout> | undefined;
  let wakeWorkerContext: ExtensionContext | undefined;
  let heldWakeMessages: AgentMessage[] = [];
  const clearWakeWorkers = () => {
    if (wakeWorkerTimer) clearTimeout(wakeWorkerTimer);
    wakeWorkerTimer = undefined; wakeWorkerContext = undefined; wakeWorkers.clear(); heldWakeMessages = [];
  };
  /** The messages of the current run, read when it settles to report what a heartbeat wake did. */
  let turn: AgentMessage[] = [];
  const idleMinutes = () => Math.round((Date.now() - settledAt) / 60_000);
  /** How the last assistant message ended when it was not a normal stop: its stop reason, then its error. */
  const lastStopOf = (ctx: ExtensionContext) => {
    const last = ctx.sessionManager.getBranch().findLast(e => e.type === 'message' && e.message.role === 'assistant');
    const message = last?.type === 'message' && last.message.role === 'assistant' ? last.message : undefined;
    return message && message.stopReason !== 'stop' ? `${message.stopReason}${message.errorMessage ? `: ${oneLine(message.errorMessage).slice(0, 300)}` : ''}` : undefined;
  };
  /** What the heartbeat's cheap model reads: why the chat stopped, what still runs, the state and the newest memory lines. */
  const beatState = (ctx: ExtensionContext, a: Active, radar?: string) => {
    const now = Date.now(), age = (since: number) => { const m = Math.round((now - since) / 60_000); return m < 120 ? `${m} min` : `${Math.round(m / 60)} h`; };
    const lastStop = lastStopOf(ctx);
    const agents = a.children.ids.flatMap(id => a.children.live(id)?.info ?? []).map(r => `${r.id} ${r.state} for ${age(r.started)}: ${oneLine(r.task).slice(0, 160)}`);
    const jobs = runningShells(shells).map(j => `${j.id} running for ${age(j.started)}: ${oneLine(j.command).slice(0, 160)}`);
    return beatSnapshot({ view: a.memory.render(), state: renderOperationalContext(readOperationalState(join(a.dir, 'operational-state.json'))),
      idleMinutes: idleMinutes(), lastStop, agents, shells: jobs, plan: heartbeatPlan(a.config), queueItem: nextQueueItem(a.dir), radar });
  };
  const showTitle = (ctx: ExtensionContext) => {
    const a = active;
    if (a) title.show(text => ctx.ui.setTitle(text), mainTitle(a.name, working, a.children.ids.length));
  };
  /** Journals written before batches held plain strings. */
  const isPendingReport = (s: unknown): s is string | { text: string; count?: number; awaitingProcessing?: boolean } =>
    typeof s === 'string' || record(s) && typeof s.text === 'string' && (s.count === undefined || typeof s.count === 'number')
      && (s.awaitingProcessing === undefined || typeof s.awaitingProcessing === 'boolean');
  const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
  pi.registerFlag('optchat-profile', { description: 'OptChat profile (required for noninteractive sessions without a saved binding)', type: 'string' });
  pi.registerFlag('optchat-connect', { description: 'pi -p on a profile open in another Pi: auto (join it if busy, default), join (only join), off (error if busy)', type: 'string', default: 'auto' });
  pi.registerFlag('optchat-agent', { description: 'Open an existing background agent by exact ID in this terminal (TUI only; requires a running profile owner)', type: 'string' });
  const connectMode = () => {
    const mode = pi.getFlag('optchat-connect') ?? 'auto';
    const known = CONNECT_MODES.find(m => m === mode);
    if (!known) { process.exitCode = 1; throw new Error(`--optchat-connect must be ${CONNECT_MODES.join(', ')}; got ${String(mode)}`); }
    return known;
  };
  /** Pi exits 0 after an extension error; a pipeline must see a failed join. */
  const joinProfile = async (name: string) => {
    try { return await joinHeadless(profilePath(name)); }
    catch (error) { process.exitCode = 1; throw error; }
  };
  const required = () => { if (!active) throw new Error('Choose an OptChat profile first: /optchat profile'); return active; };
  const status = (ctx: ExtensionContext) => {
    const a = active;
    if (!a) { ctx.ui.setStatus('optchat', 'OptChat: choose profile'); return; }
    // A display only: a broken import journal is refused where it matters, never here.
    let note = '';
    try { note = importing ? ' · importing' : pendingImport(a.dir) ? ' · import paused: /optchat import' : ''; }
    catch { note = ' · import journal invalid'; }
    ctx.ui.setStatus('optchat', `OptChat: ${a.name} · ${a.memory.root.length} messages · ${a.memory.pending} pending · ${a.children.ids.length} agents${note}`);
  };
  // `steered` describes this process's Pi queue, so it is not journaled.
  const saveReports = () => { if (active) atomicWrite(join(active.dir, 'pending-reports.json'), JSON.stringify(reports, (key, value: unknown) => ['steered', 'sentAt', 'observed', 'responded'].includes(key) ? undefined : value)); };
  /** A report already journaled when the model first saw it: its replay is processed, not logged twice. */
  const isReplayedReport = (message: AgentMessage, receipt: string | undefined) => !!receipt?.startsWith(REPORT_RECEIPT) && message.role === 'user'
    && reports.some(r => r.awaitingProcessing && r.text === textContent(message.content))
    && !!active?.memory.root.some(e => e.receipt === receipt);
  /** A bundled message is logged as the reports it carries, each with its own receipt, and each leaves the journal once logged. */
  const logBundle = (a: Active, message: AgentMessage, carried: Report[]) => {
    try {
      for (const report of carried) {
        if (!reports.includes(report)) continue;
        logMessage(a.memory, { ...message, content: report.text } as AgentMessage, reportReceipt(report.text));
        reports = reports.filter(r => r !== report);
      }
    } finally { saveReports(); }
  };
  const flush = () => {
    if (!active) return;
    while (logged < run.length) {
      const message = run[logged];
      const carried = bundled.get(message);
      if (carried) { logBundle(active, message, carried); receipts.delete(message); logged++; continue; }
      const receipt = receipts.get(message);
      if (!isReplayedReport(message, receipt)) logMessage(active.memory, message, receipt, fullToolResults.get(message));
      logged++;
      if (receipt && !receipt.startsWith(REPORT_RECEIPT)) active.inbox.acknowledge(receipt);
      receipts.delete(message);
      if (message.role === 'user') {
        const text = textContent(message.content), index = reports.findIndex(r => !r.batch && r.text === text);
        if (index >= 0 && !reports[index].awaitingProcessing && !reports[index].workerRecovery) { reports.splice(index, 1); saveReports(); }
      }
    }
  };
  // Shown as a dark background box, not as the user's own message. Before this profile has run once there is no
  // built system prompt to reuse, so that rare case still goes through Pi's normal prompt path as a user message.
  const sendReport = (report: Report) => sendReports([report]);
  /** Reports that wait together go out together: what the quota hold keeps comes back as one delivery, so does a startup replay. */
  const sendReports = (items: Report[]) => dispatchReports(items.filter(report => !outage?.offer(report)));
  const dispatchReports = (items: Report[]) => {
    for (const report of items) report.sentAt = Date.now();
    if (reportDispatch) reportDispatch.pushAll(items); else for (const report of items) sendToPi(report, idle());
  };
  /** A report that must not share its message: a wake waits on it by its text, or it is an instruction rather than news. */
  const travelsAlone = (report: Report) => !!report.solo || !!report.awaitingProcessing || !!report.workerRecovery || report.batch !== undefined
    || !!report.runIds && !!heartbeat?.waking || wakeWorkers.hasReport(report.text);
  const packWaiting = (waiting: Report[]) => packReports(waiting, travelsAlone, (members, text, count): Report => ({ text, count, members }));
  const sendToPi = (report: Report, fromIdle: boolean) => {
    const { text, count } = report;
    for (const carried of report.members ?? [report]) { carried.steered = !fromIdle; carried.sentAt = Date.now(); }
    if (report.members) {
      bundles.set(text, report.members);
      for (const key of [...bundles.keys()].slice(0, -BUNDLES_KEPT)) bundles.delete(key);
    }
    if (prompt) pi.sendMessage<ReportDetails>({ customType: REPORT_TYPE, content: text, display: true, details: { count } }, { triggerTurn: true, deliverAs: 'steer' });
    else pi.sendUserMessage(text, { deliverAs: 'steer', expandPromptTemplates: false });
  };
  const deliverReport = async (text: string, { once = false, count, runIds, workerRecovery }: { once?: boolean; count?: number; runIds?: string[]; workerRecovery?: boolean } = {}) => {
    if (once && (active?.memory.root.some(e => e.receipt === reportReceipt(text)) || reports.some(r => r.text === text))) return;
    if (runIds && heartbeat?.waking) {
      wakeWorkers.queued(text, runIds);
      if (wakeWorkerContext) watchWakeWorkers(wakeWorkerContext);
    }
    const report = { text, count, ...runIds ? { runIds } : {}, ...workerRecovery ? { workerRecovery } : {},
      ...wakeWorkers.hasReport(text) ? { awaitingProcessing: true } : {} };
    reports.push(report); saveReports();
    if (!stopping) sendReport(report);
  };
  const holdReports = (batch: string, texts: string[]) => {
    reports = [...reports.filter(r => r.batch !== batch), ...texts.length ? [{ text: texts.join('\n\n'), count: texts.length, batch }] : []];
    saveReports();
  };
  /** Today's dream summary, once; a failure to read it is shown instead of breaking the turn. */
  const briefDream = (ctx: ExtensionContext) => {
    try { return morningSummary(); }
    catch (error) { ctx.ui.notify(`Could not read the nightly dream summary: ${errorText(error)}`, 'warning'); return undefined; }
  };
  /** A wake runs on the profile's wakeModel (a routine idle turn needs no main-model price); the main model comes back when it settles. */
  const wakeHost = (ctx: ExtensionContext): WakeHost<Model<Api>> => ({
    current: () => ctx.model, find: (provider, model) => ctx.modelRegistry.find(provider, model), setModel: model => pi.setModel(model),
    thinking: () => pi.getThinkingLevel(), setThinking: level => pi.setThinkingLevel(level), notify: (text, level) => ctx.ui.notify(text, level) });
  let wakeReloadTimer: ReturnType<typeof setTimeout> | undefined;
  const watchWakeReload = (ticket: string, ctx: ExtensionContext, profile: Active) => {
    if (wakeReloadTimer) clearTimeout(wakeReloadTimer);
    const deadline = heartbeat?.reloadDeadline(ticket) ?? Date.now();
    wakeReloadTimer = setTimeout(() => {
      wakeReloadTimer = undefined;
      if (active !== profile || stopping || !heartbeat?.releaseReload(ticket, 'not-verified')) return;
      selfReload.expire(ticket, ctx);
      const note = '[OptChat heartbeat] The self-reload continuation was not observed within its deadline. Inspect the persisted ticket and current state; do not repeat the reload or any other effect. Continue the same wake only after reconciling its outcome.';
      ctx.ui.notify('Wake continuation not verified; recovering the same wake without replaying reload.', 'warning');
      void deliverReport(note).catch(error => ctx.ui.notify(`Wake recovery could not be delivered: ${errorText(error)}`, 'error'));
    }, Math.max(0, deadline - Date.now()));
    wakeReloadTimer.unref?.();
  };
  const startHeartbeat = (ctx: ExtensionContext, profile: Active) => {
    const own = () => active === profile ? profile : undefined;
    const reloadTicket = reloadLease(ctx, profile.name);
    heartbeat = new Heartbeat({ dir: profile.dir, now: Date.now,
      minutes: () => own()?.config.heartbeatMinutes ?? 0, maxWakes: () => own()?.config.heartbeatWakes ?? 0, always: () => own()?.config.heartbeatAlways ?? false,
      busy: () => stopping || !own() ? 'closed' : working || !idle() ? 'working' : reports.length ? 'reports queued' : importing || pendingImport(profile.dir) ? 'importing' : undefined,
      queued: () => nextQueueItem(profile.dir) !== undefined,
      // The radar's last snapshot stays in radar.md so a person can see what the wake saw.
      radar: async () => {
        const argv = own()?.config.heartbeatRadar;
        if (!argv) return undefined;
        const text = await runRadarFresh(argv, () => loadConfig(profile.dir).heartbeatRadar);
        try { atomicWrite(join(profile.dir, 'radar.md'), `${text}\n`); } catch (error) { ctx.ui.notify(`Heartbeat could not save radar.md: ${errorText(error)}`, 'warning'); }
        return text;
      },
      check: radar => own() ? checkBeat(ctx.modelRegistry, modelFor(profile.config, 'compactor', main), beatState(ctx, profile, radar),
        message => profile.usage.compression(message, 'heartbeat', profile.sessionId)) : Promise.reject(new Error('profile closed')),
      // Cached quota only (pi-multi-account keeps the file): a wake never starts on a provider known to be out, and never probes one.
      route: blocks => {
        const model = main ?? (ctx.model && { provider: ctx.model.provider, model: ctx.model.id });
        const config = own()?.config;
        if (!config) return undefined;
        const state = readJsonOr<unknown>(QUOTA_FILE, {});
        return pickWakeRoute(wakeRoutes(config, model, knownProviders(state, blocks), pi.getThinkingLevel()), state, blocks, Date.now(),
          choice => !!ctx.modelRegistry.find(choice.provider, choice.model));
      },
      // Event-driven wakes (config wakeTriage): the radar and the crew's runs say which projects moved; no model is asked.
      triage: () => {
        const triage = own()?.config.wakeTriage;
        if (!triage) return undefined;
        const lastRuns = Object.fromEntries(Object.entries(lastRunsOf(profile.children.runs(), Date.now())).map(([project, run]) => [project, run.at]));
        return { buildMinutes: triage.buildMinutes, ...triage.stallHours ? { stallHours: triage.stallHours } : {}, missions: profile.crew.missions(), lastRuns, lastStop: lastStopOf(ctx), commitments: readCommitments(profile.dir) };
      },
      // Specialist patrol (config specialistPatrol): a specialist's deadline findings go to a read-only worker of that specialist, not to the manager.
      patrol: () => {
        const plan = own()?.config.specialistPatrol;
        if (!plan) return undefined;
        return createPatrol({ plan, dir: profile.dir, specialists: () => profile.crew.specialists(), runs: () => profile.children.runs(),
          spawn: (task, cwd) => profile.children.spawn([task], cwd), escalate: (project, line) => heartbeat?.escalate(project, line) });
      },
      wake: (beat, radar, choice) => {
        wakeRetried = false; clearWakeWorkers();
        const dream = briefDream(ctx);
        const runs = lastRunsOf(profile.children.runs(), Date.now());
        const note = beat.signals?.length ? crewWakeNote(profile.crew.missions(), [], [], beat.signals.map(signal => ({ ...signal, lastRun: runs[signal.project]?.id })))
          : profile.config.managerMode ? crewWakeNote(profile.crew.missions(), profile.crew.auditReasons(), profile.crew.pendingCounts()) : '';
        const text = wakeTurn(beat.trigger === 'signal' ? signalWakeText(idleMinutes(), heartbeatPlan(profile.config), note)
          : wakeText(beat.text, beat.model ?? 'compactor', idleMinutes(), heartbeatPlan(profile.config), { path: queueFile(profile.dir), item: nextQueueItem(profile.dir) }, radar) + (note ? `\n${note}` : ''), previousWake(profile.dir), beat.unchanged);
        const target = choice ? (choice.provider === main?.provider && choice.model === main.model ? undefined : choice) : wakeModelFor(profile.config, main);
        wakeOn(profile.dir, target, wakeHost(ctx)).catch(error => ctx.ui.notify(`Wake model switch failed: ${errorText(error)}`, 'warning'))
          .then(() => deliverReport(dream ? `${text}\nLast night's dream, to pass on in your report as these three lines:\n${dream}` : text))
          .catch(error => { void wakeOff(profile.dir, wakeHost(ctx)).catch(() => undefined); ctx.ui.notify(`Heartbeat could not wake the agent: ${errorText(error)}`, 'error'); }); },
      note: text => ctx.ui.notify(text, 'warning'),
      setTimer: (run, ms) => setTimeout(run, ms).unref(),
      clearTimer: handle => clearTimeout(handle as ReturnType<typeof setTimeout>) }, reloadTicket);
    if (reloadTicket && heartbeat.waking) watchWakeReload(reloadTicket, ctx, profile);
    settledAt = Date.now(); heartbeat.arm();
    // The daily retro (operator 03/11): once a day after the configured time, on an idle chat.
    if (retroTimer) clearInterval(retroTimer);
    retroTimer = setInterval(() => {
      const at = own()?.config.dailyRetro;
      if (!at || at === 'off' || stopping || working || !idle() || reports.length) return;
      const now = Date.now();
      if (!retroDue(profile.dir, now, at)) return;
      try { markRetro(profile.dir, now); } catch (error) { ctx.ui.notify(`Daily retro could not be recorded: ${errorText(error)}`, 'warning'); return; }
      void deliverReport(retroPrompt(new Date(now).toLocaleDateString('sv-SE'), machineService()?.insights(24 * 3_600_000, now))).catch(error => ctx.ui.notify(`Daily retro could not start: ${errorText(error)}`, 'error'));
    }, 60_000);
    retroTimer.unref?.();
  };
  /** The machine sampler: one per main session, never in workers (they do not load this extension). Alerts reach the main agent like a shell's. */
  const startMachineSense = (ctx: ExtensionContext, memory: unknown) => {
    if (ctx.mode === 'print' || ctx.mode === 'json' || process.platform !== 'win32') return;
    const service = MachineService.start({ agentDir: getAgentDir(), lowerOwn: () => active?.config.machineLower ?? true,
      notify: text => { if (!stopping && active?.memory === memory) void deliverReport(text).catch(error => ctx.ui.notify(`Machine alert could not be delivered: ${errorText(error)}`, 'error')); },
      runs: () => active?.children.runs().map(run => ({ id: run.id, started: run.started })) ?? [] });
    const handles = new Map<string, number>();
    shells.setLifecycleObserver({
      began: job => { handles.set(job.id, service.sense.began({ id: job.id, command: job.command, mode: job.mode, agent: job.owner?.startsWith('agent ') ? job.owner : undefined }, job.started)); },
      ended: job => { const handle = handles.get(job.id); if (handle !== undefined) service.sense.ended(handle); handles.delete(job.id); },
    });
  };
  /** What changed on the PC and in the harness, said at the start of a turn (the `situationDigest` setting); one per main session. */
  const startSituation = (ctx: ExtensionContext, dir: string) => {
    if (ctx.mode === 'print' || ctx.mode === 'json') return;
    situation = new Situation({ stateFile: join(dir, 'situation-state.json'), logFile: join(dir, 'situation-digest.jsonl'),
      collector: new Collector(realSources({ agentDir: getAgentDir(), machine: () => machineService()?.sense.now(),
        work: () => ({ agents: active?.children.working.length ?? 0, shells: runningShells(shells).length }) })) });
    void situation.warm();
  };
  const stop = async (reason?: string) => {
    situation = undefined;
    machineService()?.stop(); shells.setLifecycleObserver(undefined);
    heartbeat?.disarm(); heartbeat = undefined; clearWakeWorkers();
    outage?.close(); outage = undefined;
    reportDispatch?.close(); reportDispatch = undefined;
    if (wakeReloadTimer) clearTimeout(wakeReloadTimer); wakeReloadTimer = undefined;
    if (retroTimer) clearInterval(retroTimer); retroTimer = undefined;
    for (const unwatch of unwatchWork.splice(0)) unwatch();
    remote?.close(); remote = undefined; joined?.close(); joined = undefined;
    inspectorController?.abort(); unmountNavigation?.(); unmountNavigation = undefined; unmountBoard?.(); unmountBoard = undefined; board?.close(); board = undefined;
    stopping = true; importController?.abort(); await importTask?.catch(() => {});
    const handOff = reason === 'reload' && active !== undefined;
    if (handOff) handOffShells(shells, active!.name);
    else { await shells.close(); shells.setReporter(undefined); }
    if (!active) return;
    const old = active;
    try {
      await closeWindows?.(); closeWindows = undefined;
      await recovery;
      await old.children.close(); await old.crew.closeAll(); if (!handOff) shells.clear(); flush(); for (const text of peerCopies.splice(0)) old.memory.append('work', text); if (!pendingImport(old.dir)) old.inbox.recover(old.memory);
      await old.sync.close(); await old.memory.close(reason === 'reload' ? 'reload' : reason ? 'shutdown' : 'memory_close'); await checkpoints;
      await checkpoint(old.dir);
    } finally {
      await old.crew.closeAll(); await old.memory.close(); await old.unlock(); active = undefined;
      run = []; previous = []; logged = 0; keep = 0; view = undefined; focusView = undefined; lastRequestAt = undefined; runStarted = false; receipts.clear(); prompt = ''; idle = () => true;
      records = undefined;
      untitle?.(); untitle = undefined; title.clear(); working = false;
    }
  };
  const CONNECT = 'Start a connected subagent conversation here', BACK = 'Back';
  const chooseProfile = async (ctx: ExtensionContext): Promise<string | undefined> => {
    // Outside the TUI (print, json, RPC hosts) never pick or create a profile: a dialog would hang the host, and a guess could write into the wrong memory.
    if (ctx.mode !== 'tui') return undefined;
    const names = listProfiles(), last = lastProfile();
    if (last) names.sort((a, b) => Number(b === last) - Number(a === last));
    const selected = await ctx.ui.select('OptChat profile', [...names, '+ Create profile']);
    if (selected !== '+ Create profile') return selected;
    const name = (await ctx.ui.input('New profile name', 'work or personal'))?.trim();
    if (!name) return undefined;
    createProfile(name); return name;
  };
  const openProfile = async (name: string, ctx: ExtensionContext) => {
    const dir = profilePath(name);
    if (!existsSync(dir)) throw new Error(`Profile ${name} does not exist. Use /optchat profile to create it.`);
    const unlock = await holdProfile(storeFor(dir), dir, name, `${name} · PID ${process.pid} · ${hostname()} · ${ctx.cwd}`, warning => ctx.ui.notify(warning, 'warning'));
    let openingMemory: Memory | undefined;
    try {
      const config = loadConfig(dir);
      main = ctx.model && { provider: ctx.model.provider, model: ctx.model.id };
      const sessionId = ctx.sessionManager.getSessionId();
      const usage = new UsageLedger(dir);
      const operations = new OperationJournal(dir);
      const metrics = new PerformanceMetrics();
      const outputs = new OutputContext(new OutputStore(dir, sessionId));
      usage.backfill(ctx.sessionManager.getEntries(), sessionId);
      const pending = join(dir, 'pending-reports.json');
      const saved: unknown = existsSync(pending) ? JSON.parse(readFileSync(pending, 'utf8')) : [];
      if (!Array.isArray(saved) || !saved.every(isPendingReport)) throw new Error('Invalid pending report journal.');
      let diagnosticsFailed = false;
      const closed = closedConflictsOf(dir, warning => ctx.ui.notify(warning, 'warning'));
      const compress = createCompressor(ctx.modelRegistry, () => modelFor(config, 'compactor', main), (message, attribution) => {
        usage.compression(message, 'compactor', sessionId, attribution);
        status(ctx);
      }, () => config.summaryAcceptBytes, shared, diagnostic => {
        try { writeCompactorDiagnostic(dir, diagnostic); }
        catch (error) { if (!diagnosticsFailed) { diagnosticsFailed = true; ctx.ui.notify(`Could not save compactor diagnostics: ${errorText(error)}`, 'warning'); } }
      }, undefined, () => ({ sessionId, recoveryIncidentId: recoveryIncidents.get(sessionId) }), closed);
      const memory = await Memory.open(memoryDirectory(dir), async (input, signal) => {
        const started = performance.now();
        try { return await compress(input, signal); }
        finally { metrics.record('compaction', performance.now() - started); }
      }, warning => ctx.ui.notify(warning, 'error'), undefined, undefined, undefined, DEFER);
      openingMemory = memory;
      void cleanClosedOnce(dir, memory, closed()).then(changed => { if (changed) ctx.ui.notify(`OptChat rewrote ${changed} memory lines that cited closed conflicts.`, 'info'); },
        error => ctx.ui.notify(`Could not clean closed conflicts from memory: ${errorText(error)}`, 'warning'));
      const inbox = new Inbox(dir);
      const recovered = pendingImport(dir) ? 0 : inbox.recover(memory);
      if (recovered) ctx.ui.notify(`Recovered ${recovered} unanswered inputs into ${name}'s memory. Ask to continue them when ready.`, 'info');
      // The specialists' trees get their own compressor, on the compactor's model, billed as "crew"; it pauses on a per-token provider.
      const crewCompress = createCompressor(ctx.modelRegistry, () => modelFor(config, 'compactor', main), (message, attribution) => {
        usage.compression(message, 'crew', sessionId, attribution);
      }, () => config.summaryAcceptBytes, () => undefined);
      const crew = new Crew(join(dir, 'crew'), {
        compress: pauseOnApiKey(crewCompress, () => resolveModel(ctx.modelRegistry, modelFor(config, 'compactor', main))?.provider, provider => quotaPlan(provider)),
        warn: text => ctx.ui.notify(text, 'warning'), note: text => ctx.ui.notify(text, 'info') });
      const children = new Children(memory, ctx.modelRegistry, () => modelFor(config, 'subagent', main), () => `${instructions(dir)}\n\n${IMPORT_GUIDANCE}\n\n${renderOperationalContext(readOperationalState(join(dir, 'operational-state.json')))}`,
        deliverReport, text => ctx.ui.notify(text, 'error'), dir, { parentSession: sessionId, usage, operations, recoveryEvent, recoveryIncident: sessionId => recoveryIncidents.get(sessionId), shells, events: pi.events,
          onTiming: event => { if (event.durationMs !== undefined && (event.phase === 'open' || event.phase === 'settle')) metrics.record(event.phase === 'open' ? 'child_open' : 'settle', event.durationMs); }, builtins: () => loadedBuiltins(pi), settings: () => config, hold: holdReports, profileInstructions: () => instructions(dir),
          summarizeHandoff: createHandoffSummarizer(ctx.modelRegistry, () => modelFor(config, 'compactor', main), message => usage.compression(message, 'compactor', sessionId)),
          route: kind => routeFor(kind, main, config.workerModels), crew, onRunEnd: run => commitments.runEnded(run),
          escalated: (project, id) => { const item = readCommitments(dir).find(found => found.id === id); if (item) heartbeat?.escalate(project, escalationNote(item, project)); },
          quotaBlock: (provider, model) => routeBlock(readJsonOr<unknown>(QUOTA_FILE, {}), provider, model, Date.now()),
          onPark: ids => wakeWorkers.release(ids),
          // A copy, not a report: it starts no manager turn. Held while a manager run is logging its own messages, then appended after them.
          peerCopy: text => { if (active?.memory === memory && !idle()) peerCopies.push(text); else memory.append('work', text); },
          peerResumed: (resumed, partner) => {
            if (!heartbeat?.waking) return;
            wakeWorkers.adopt(resumed, partner);
            if (wakeWorkerContext) watchWakeWorkers(wakeWorkerContext);
          } });
      outage?.close();
      reportDispatch?.close();
      reportDispatch = new ReportDispatcher<Report>({ idle: () => ctx.isIdle(), send: sendToPi,
        // Pi reports a refused send nowhere the extension can read; a send that started no turn is the sign.
        pack: packWaiting, gatherMs: REPORT_GATHER_MS,
        failed: (report, attempt, giveUp) => {
          for (const carried of report.members ?? [report]) carried.sentAt = undefined;
          ctx.ui.notify(giveUp ? `A report did not start a turn after ${attempt} tries; it stays journaled and is delivered at the next start.`
            : 'A report did not start a turn; sending it again.', 'warning');
        } });
      outage = new QuotaOutage<Report>({ now: () => Date.now(),
        // Cached quota only, across the accounts of the main model's family: undefined when one of them is usable or nothing is known.
        // The hints learned from failed turns count per provider, like the failed-wake blocks of a wake.
        until: learned => {
          const model = main ?? (ctx.model && { provider: ctx.model.provider, model: ctx.model.id }), own = active?.config;
          if (!model || !own) return undefined;
          const state = readJsonOr<unknown>(QUOTA_FILE, {});
          const routes = wakeRoutes({ ...own, wakeModel: undefined, wakeRouteAcrossFamilies: false }, model, knownProviders(state, learned), pi.getThinkingLevel());
          const decision = pickWakeRoute(routes, state, learned, Date.now(), choice => !!ctx.modelRegistry.find(choice.provider, choice.model));
          return decision?.choice ? undefined : decision?.until;
        },
        notice: text => ctx.ui.notify(text, 'warning'),
        send: items => { if (active?.memory === memory && !stopping) dispatchReports(items.filter(item => reports.includes(item))); },
        setTimer: (run, ms) => setTimeout(run, Math.min(ms, 2 ** 31 - 1)).unref(),
        clearTimer: handle => clearTimeout(handle as ReturnType<typeof setTimeout>) });
      const loggedReports = new Set(memory.root.map(e => e.receipt));
      // Reports a crash held back with their unfinished siblings are delivered now, as they are.
      reports = saved.map(s => typeof s === 'string' ? { text: s } : { text: s.text, count: s.count, awaitingProcessing: s.awaitingProcessing })
        .filter(r => r.awaitingProcessing || !loggedReports.has(reportReceipt(r.text)));
      atomicWrite(pending, JSON.stringify(reports));
      rememberProfile(name);
      const sync = new Sync({ profile: name, dir, memory, statusFile: join(dataHome(), 'status.md'), model: () => main && `${main.provider}/${main.model}`,
        status: () => config.syncStatus, optmem: () => config.syncOptMem, aimemory: () => config.syncAiMemory, warn: text => ctx.ui.notify(text, 'warning') });
      active = { name, dir, config, memory, focus: new Focus(), inbox, children, crew, usage, operations, sessionId, sync, outputs, metrics, unlock }; fault = undefined; idle = () => ctx.isIdle();
      for (const unwatch of unwatchWork.splice(0)) unwatch();
      const shellSource = { subscribe: (l: () => void) => shells.subscribe(l), snapshot: () => shells.list() };
      const agentSource = { subscribe: (l: () => void) => children.subscribe(l), snapshot: () => children.working };
      unwatchWork.push(work.watchShells(shellSource), work.watchAgents(agentSource));
      void sync.now();
      board?.close();
      board = new WaitingBoard({
        runs: () => children.runs(), live: id => children.live(id), shells: () => shells.list(),
        waiting: () => active ? [...approvals?.pendingFor(active.sessionId).map(p => `aprovação: ${p.summary}`) ?? [], ...stillWaiting(waitingItems(readCommitments(active.dir), Date.now()), readWatch(active.dir)).map(item => item.text)] : [],
      }, pi.events);
      board.requestState();
      if (ctx.mode === 'tui') {
        unmountNavigation = mountNavigation(ctx, children, memory, shortcut, page => { void inspect(ctx, page); }, shells);
        unmountBoard = mountWaitingBoard(ctx, board, shortcut);
      }
      // A one-shot run (`pi -p`, JSON) exits after its own prompt, which would end every conversation connected to it.
      if (ctx.mode !== 'print' && ctx.mode !== 'json') closeWindows = await serveWindows(dir, children, () => inPhase('open'), deliverReport);
      untitle = children.subscribe(() => showTitle(ctx)); showTitle(ctx);
      status(ctx);
      ctx.ui.notify(`${brand} · ${name} · ${memory.root.length} messages\nCompactor: ${roleModel(config, 'compactor', main)}`, 'info');
      // A background shell's end (shellReporter) and its pattern alerts reach the main agent as messages. Closing the profile stops shells silently; a /reload hands them to the reloaded profile, which hears the ends it missed.
      if (adoptedProfile !== undefined && adoptedProfile !== name) {
        ctx.ui.notify(`Stopped ${runningShells(shells).length} background shells that ${adoptedProfile} left running across the reload.`, 'warning');
        await shells.close(); shells.clear();
      }
      adoptedProfile = undefined;
      shells.setReporter(shellReporter({
        live: () => !stopping && active?.memory === memory,
        main: (text, once) => deliverReport(text, { once }),
        agent: (id, text) => children.shellNotice(id, text),
        failed: (what, job, error) => ctx.ui.notify(`Could not ${what} ${job.id}: ${errorText(error)}`, 'error'),
      }));
      startMachineSense(ctx, memory);
      startSituation(ctx, dir);
      const queuedReports = [...reports];
      if (!pendingImport(dir)) {
        const recover = (work: Promise<void>, what: string) => work.catch(error => ctx.ui.notify(`${what}: ${errorText(error)}`, 'error'));
        // Only an interactive Pi picks cut-off subagents up: a one-shot headless run would stop them again as it exits.
        recovery = Promise.all([recover(children.recoverHandoffs(), 'Handoff recovery'), ...ctx.mode === 'tui' ? [recover(children.resumeCutOff(), 'Resuming subagents'), recover(Promise.resolve().then(() => children.resumeParked()), 'Re-arming workers parked for quota')] : []]).then(() => {});
      }
      setImmediate(() => { if (active?.memory === memory && !pendingImport(dir)) sendReports(queuedReports); });
      // A reload or crash in the middle of a wake left the wake model on: put the main one back.
      await wakeOff(active.dir, wakeHost(ctx)).catch(error => ctx.ui.notify(`Could not restore the main model after the wake: ${errorText(error)}`, 'error'));
      if (ctx.mode === 'tui') startHeartbeat(ctx, active);
    } catch (error) {
      await closeWindows?.(); closeWindows = undefined;
      untitle?.(); untitle = undefined; title.clear();
      if (active && active.memory === openingMemory) {
        unmountNavigation?.(); unmountNavigation = undefined;
        await active.sync.close(); await active.children.close(); active = undefined;
      }
      await openingMemory?.close();
      await unlock(); throw error;
    }
  };

  pi.on('session_start', async (_event, ctx) => {
    stopping = false;
    const entries = ctx.sessionManager.getEntries();
    const saved = entries.findLast(e => e.type === 'custom' && e.customType === binding);
    const boundName = saved?.type === 'custom' && record(saved.data) && typeof saved.data.name === 'string' ? saved.data.name : undefined;
    // A session with conversation in it belongs to its profile. One that is only bound (a fresh `/optchat profile` session) may still pick another.
    const settled = boundName !== undefined && entries.some(e => e.type === 'message' || e.type === 'custom_message');
    const flag = pi.getFlag('optchat-profile');
    try {
      if (boundName && typeof flag === 'string' && flag !== boundName) throw new Error(`Session belongs to ${boundName}; cannot resume it as ${flag}.`);
      // OPTCHAT_PROFILE skips the picker in the TUI only: headless runs must not enter a personal memory unasked.
      const preset = ctx.mode === 'tui' ? process.env.OPTCHAT_PROFILE?.trim() || undefined : undefined;
      const agentId = pi.getFlag('optchat-agent');
      if (agentId !== undefined) {
        if (typeof agentId !== 'string' || !agentId.trim()) throw new Error('--optchat-agent requires an exact agent ID');
        if (ctx.mode !== 'tui') { process.exitCode = 1; throw new Error('--optchat-agent requires interactive Pi (not print, JSON or RPC mode)'); }
        if (settled) throw new Error('This session already contains a main conversation. Open the agent in a fresh Pi session.');
        const name = boundName ?? (typeof flag === 'string' ? flag : preset);
        if (!name) throw new Error('--optchat-agent needs a profile: pass --optchat-profile or set OPTCHAT_PROFILE');
        remote = await openConnectedWindow(pi, ctx, name, text => title.show(t => ctx.ui.setTitle(t), text), agentId);
        fault = undefined;
        for (const ms of [0, 250, 1000]) setTimeout(() => title.reapply(), ms).unref();
        return;
      }
      let name = boundName ?? (typeof flag === 'string' ? flag : preset ?? await chooseProfile(ctx));
      // Only plain `pi -p` joins: JSON and RPC output carry Pi's own events, which a joined reply would bypass.
      const connect = ctx.mode === 'print' ? connectMode() : 'off';
      if (connect === 'join' && !name) { process.exitCode = 1; throw new Error('--optchat-connect join needs a profile: pass --optchat-profile'); }
      for (;;) {
        if (!name) { status(ctx); return; }
        try {
          if (connect === 'join') joined = await joinProfile(name);
          else await openProfile(name, ctx);
          break;
        } catch (error) {
          if (error instanceof ProfileBusyError && connect === 'auto') { joined = await joinProfile(name); break; }
          if (!(error instanceof ProfileBusyError) || ctx.mode !== 'tui') throw error;
          // A resumed conversation already belongs to this profile, so another profile needs a new session (/optchat profile).
          // Older owners have no listing protocol. Keep their existing Connect/Back menu rather than failing startup.
          const listed = settled ? undefined : await listAttachableAgents(profilePath(name)).catch(() => undefined);
          const agents = listed ?? [];
          const hint = listed?.length === 0 ? '\nNo background agents are running. Ask the main agent to start one.' : '';
          const labels = new Map(agents.map(agent => [`Open subagent ${agent.id} · ${agent.state} · ${oneLine(agent.task).slice(0, 80)}`, agent.id]));
          const choice = await ctx.ui.select(`${name} is open in another window\n${error.owner}${hint}`,
            [CONNECT, ...labels.keys(), ...(settled ? [] : [BACK])]);
          const agentId = choice && labels.get(choice);
          if (agentId) {
            try {
              remote = await openConnectedWindow(pi, ctx, name, text => title.show(t => ctx.ui.setTitle(t), text), agentId, true);
              fault = undefined;
              // An attached terminal saves no profile binding: its Pi session never persists, so there is nothing to resume.
              for (const ms of [0, 250, 1000]) setTimeout(() => title.reapply(), ms).unref();
              return;
            } catch (error) {
              ctx.ui.notify(errorText(error), 'error');
              continue; // It may have finished while the menu was open: refresh, never spawn a replacement.
            }
          }
          if (choice === CONNECT) { remote = await openConnectedWindow(pi, ctx, name, text => title.show(t => ctx.ui.setTitle(t), text)); fault = undefined; break; }
          if (choice !== BACK) throw error;
          name = await chooseProfile(ctx);
        }
      }
      if (name !== boundName) pi.appendEntry(binding, { name });
      if (active) {
        // After /reload the prompt cache is still warm: keep the head it holds and the time of the last request.
        const branch = ctx.sessionManager.getBranch();
        const entry = branch.findLast(e => e.type === 'custom' && e.customType === HEAD_ENTRY);
        stableHead.restore(readHeadFile(active.dir, active.sessionId) ?? (entry?.type === 'custom' ? entry.data : undefined));
        savedHead = stableHead.saved();
        // And the view entries it holds: without them the first call marks only its last blocks, and a view that grew by more
        // than their lookback since is written again whole.
        const entriesFile = join(active.dir, VIEW_ENTRIES_FILE);
        if (existsSync(entriesFile)) {
          try { viewEntries.restore(JSON.parse(readFileSync(entriesFile, 'utf8'))); }
          catch { console.error(`OptChat could not read ${VIEW_ENTRIES_FILE}; the view is written to the cache again.`); }
        }
        const last = branch.findLast(e => e.type === 'message' && e.message.role === 'assistant');
        lastRequestAt = last?.type === 'message' && last.message.role === 'assistant' ? last.message.timestamp : undefined;
      }
    } catch (error) {
      if (active) await stop().catch(() => {});
      fault = errorText(error);
      // Pi reports a throwing handler on stderr (print) or as an extension_error event (RPC); notify there is a no-op or easy to miss.
      if (ctx.mode !== 'tui') throw error;
      ctx.ui.notify(fault, 'error');
    }
    // Pi sets its own title once every session_start handler has finished, so put ours back afterwards.
    for (const ms of [0, 250, 1000]) setTimeout(() => title.reapply(), ms).unref();
  });
  pi.on('model_select', event => { main = { provider: event.model.provider, model: event.model.id }; outage?.recheck(); active?.sync.schedule(); });
  pi.on('session_info_changed', () => title.reapply()); // Pi retitles the tab on session renames, just before this.
  pi.on('session_shutdown', async event => {
    if (event.reason === 'reload') noteReload();
    try { await stop(event.reason); }
    // The shells outlive a /reload in this process: they must not keep this instance's closure alive, nor report into it.
    finally { unsubscribeRecovery(); recoveryIncidents.clear(); shells.setEndObserver(undefined); }
  });
  // Pi shows nothing when a switch is cancelled, so say why and what lets it through.
  const blockSwitch = (command: string, ctx: ExtensionContext) => {
    const children = active?.children, runs = children?.active ? children.ids.flatMap(id => children.live(id)?.info ?? []) : [];
    const label = (run: RunInfo) => !isActiveRun(run) ? 'finishing' : run.connected ? 'connected window'
      : run.state === 'paused' ? 'interrupted, waiting for you' : run.state === 'stopping' ? 'stopping' : 'working';
    const own = runs.filter(run => !run.connected), it = own.length === 1 ? 'it' : 'them';
    const how = [
      ...own.length ? [own.some(run => run.state === 'paused') ? `Open ${it} in /optchat agents and message ${it} to resume, or press Ctrl+X twice to stop.`
        : `Wait for ${it} to finish, or open ${it} in /optchat agents and press Ctrl+X twice.`] : [],
      ...runs.length > own.length ? [own.length || runs.length > 1 ? 'A connected window\'s agent ends when its window runs /complete or closes.' : 'It ends when that window runs /complete or closes.'] : [],
    ];
    const why = remote && !remote.ended ? 'in a connected window. Run /complete to end this conversation, then open a new Pi window.'
      : importing ? 'while an import is open. Close the import dialog or pause the import (Escape), then try again.'
      : !children?.active ? undefined
      : !runs.length ? 'while agents are starting or finishing. Try again in a moment.'
      : `while ${runs.length === 1 ? '1 agent is' : `${runs.length} agents are`} active: ${runs.map(run => `${run.id} (${label(run)})`).join(', ')}. ${how.join(' ')}`;
    if (!why) return undefined;
    ctx.ui.notify(`${command} is blocked ${why}`, 'warning');
    return { cancel: true };
  };
  pi.on('session_before_switch', (event, ctx) => blockSwitch(event.reason === 'new' ? '/new' : '/resume', ctx));
  pi.on('session_before_fork', (event, ctx) => blockSwitch(event.position === 'at' ? '/clone' : '/fork', ctx));
  registerAssistant(pi, () => {
    const a = active;
    return a && inPhase('open') ? { identity: a, name: a.name, dir: a.dir, sessionId: a.sessionId, zoom: (id, offset, limit) => a.memory.zoom(id, 1, offset, limit), localInbox: cursor => projectLocalInbox({ profileId: a.name, sessionId: a.sessionId, approvals: approvals?.pendingFor(a.sessionId) ?? [], operations: a.operations.snapshot(), runs: a.children.runs() }, cursor), attention: () => ({ approvals: approvals?.pendingFor(a.sessionId).length ?? 0, uncertain: a.operations.pending().length, agents: a.children.ids.length }) } : undefined;
  });
  registerAssistantMemory(pi, () => {
    const a = active;
    return a && inPhase('open')
      ? { identity: a, profileId: a.name, sessionId: a.sessionId, memory: a.memory, databasePath: join(a.dir, 'assistant-memory', 'corrections.sqlite'), ...(process.env.OPTCHAT_ABOUT_ME ? { aboutMePath: process.env.OPTCHAT_ABOUT_ME } : {}) }
      : undefined;
  });
  const slackOwner = () => active && inPhase('open', 'import-paused') ? { dir: active.dir, name: active.name } : undefined;
  // A paused import still takes the reports out, but a DM is delivered only to a profile that can run it: the input hook drops
  // messages while an import is paused, and the bridge has already moved its cursor past a message it handed over.
  const slack = registerSlackBridge(pi, slackOwner, (channel, text) => { try { if (active) logSent(active.dir, channel, text); } catch { /* the day log only feeds the morning summary */ } },
    { accepting: () => inPhase('open'), nextWake: () => heartbeat?.nextAt, deferEnd: true, economy: cachedEconomy(() => slackOwner()?.dir),
      // The App Home's work items: read-only, from this profile's files and the shells running now (src/home-items.ts).
      items: () => {
        const a = active;
        if (!a || !inPhase('open', 'import-paused')) return NO_WORK;
        const agents = a.children.ids.flatMap(id => a.children.live(id)?.info ?? []).filter(r => r.state === 'running').map(r => `subagente ${r.id} \u00b7 ${oneLine(r.task)}`);
        return readHomeWork(a.dir, runningShells(shells).map(job => `${job.id} \u00b7 ${job.command}`), Date.now(), agents);
      } });
  // The App Home lists what waits on him: approvals pending in this chat and commitments blocked on him.
  slack.setWaiting(() => {
    if (!active) return [];
    const approvals$ = approvals?.pendingFor(active.sessionId) ?? [];
    return [...approvals$.map(p => `Aprovação pendente: ${p.summary}`), ...stillWaiting(waitingItems(readCommitments(active.dir), Date.now()), readWatch(active.dir))];
  });
  // The operator's WhatsApp through wacli, when ~/.pi/agent/optchat-whatsapp.json exists (src/whatsapp-bridge.ts).
  registerWhatsAppBridge(pi, () => active && inPhase('open') ? active.dir : undefined, () => slack.commandState(), () => inPhase('open'));
  // PRs changing state and a 07:00 summary in the DM (src/slack-reports.ts).
  registerSlackReports(pi, slackOwner, (text, channel, topic) => slack.post(text, channel, topic), () => active ? approvals?.pendingFor(active.sessionId).length ?? 0 : 0);
  // Production health probes every 5 min, read-only: an outage posts to #dentai and wakes the agent once (src/prod-health.ts).
  registerQuotaCommand(pi, () => slackOwner()?.dir);
  registerProdHealth(pi, slackOwner, (text, channel) => slack.post(text, channel), text => deliverReport(text, { once: true }));
  // The operator's panel mirrors runs, wakes, background shells and subagents (src/work-tracker.ts).
  const work = registerWorkTracker(pi, () => active && inPhase('open', 'import-paused') ? { dir: active.dir, name: active.name, sessionId: active.sessionId } : undefined);
  const unwatchWork: (() => void)[] = [];
  const catchup = registerCatchup(pi, () => active && inPhase('open', 'closing')
    ? catchupSource(active, flush, approvals, shells) : undefined);
  // What OptChat promised and what waits on the operator, in every turn, plus the 10/30-min presence nudges (src/commitments.ts).
  const commitments = registerCommitments(pi, () => {
    const a = active;
    return a && inPhase('open', 'closing', 'import-paused') ? {
      dir: a.dir,
      sourceExists: (id: string) => { flush(); return /^(0|[1-9]\d*)$/.test(id) && a.memory.root[Number(id)] !== undefined; },
      latestSource: () => { flush(); const latest = latestOperatorMessage(a.memory.root); return latest ? String(latest.i) : undefined; },
    } : undefined;
  });
  // An operator correction gets one reminder to become a test or rule, and counts on the weekly scoreboard (src/corrections.ts).
  registerCorrections(pi, () => active && inPhase('open', 'closing', 'import-paused') ? { dir: active.dir } : undefined);
  pi.on('input', async (event, ctx) => {
    if (joined) {
      try {
        if (event.images?.length) throw new Error('Joining a running profile accepts text only; provide a file path for the agent to read.');
        await printReply(await joined.ask(event.text, ctx.cwd));
      } catch (error) { process.stderr.write(`OptChat: ${errorText(error)}\n`); process.exitCode = 1; }
      return { action: 'handled' };
    }
    if (remote) {
      try {
        if (event.images?.length) throw new Error('Connected windows currently accept text only; provide a file path for the agent to read.');
        await remote.submit(event.text);
      } catch (error) { ctx.ui.notify(errorText(error), 'error'); ctx.ui.setEditorText(event.text); }
      return { action: 'handled' };
    }
    if (!active) {
      // Without a profile or flag, a headless run is plain Pi. A requested profile that failed to open refuses instead of running without memory.
      if (ctx.mode !== 'tui' && !fault) return { action: 'continue' };
      ctx.ui.notify(fault ?? 'Select a profile with /optchat profile before chatting.', 'error'); return { action: 'handled' };
    }
    if (importing || pendingImport(active.dir)) { ctx.ui.notify('This profile has an import in progress. Use /optchat import to resume or discard it, or switch profiles.', 'info'); return { action: 'handled' }; }
    if (event.source !== 'extension') {
      heartbeat?.operatorSpoke();
      if (!wakeWorkers.holding) clearWakeWorkers();
      const journaled = performance.now();
      try { active.inbox.record(event.text, event.streamingBehavior !== undefined); }
      catch (error) { ctx.ui.notify(`Could not save input: ${errorText(error)}`, 'error'); return { action: 'handled' }; }
      finally { active.metrics.record('input', performance.now() - journaled); }
    }
    return { action: 'continue' };
  });
  const startRun = (ctx: ExtensionContext) => {
    flush(); run = []; logged = 0; keep = 0; view = undefined; focusView = undefined; runStarted = true; viewEpoch++; runSeq++;
    const config = active?.config;
    previous = config?.previousExchange ? previousExchange(ctx.sessionManager.getBranch(), config.previousExchangeKB * 1000) : [];
    pi.appendEntry(RUN_BOUNDARY, { state: 'start' });
  };
  // A report sent while Pi is idle starts its run without before_agent_start; it reuses the last built prompt.
  pi.on('agent_start', (_event, ctx) => {
    reportDispatch?.started();
    working = true; turn = []; showTitle(ctx); heartbeat?.disarm();
    if (active && !runStarted) startRun(ctx);
  });
  pi.on('before_agent_start', (event, ctx) => {
    if (!active) return; // Plain Pi run: leave Pi's own prompt untouched.
    if (event.messageType === 'custom' && event.message.customType === RELOAD_RESUME) {
      const id = (event.message.details as { id?: unknown } | undefined)?.id;
      if (typeof id === 'string') commitments.reloadResumed(id);
      if (typeof id === 'string' && heartbeat?.releaseReload(id) && wakeReloadTimer) {
        clearTimeout(wakeReloadTimer); wakeReloadTimer = undefined;
      }
    }
    const started = performance.now();
    startRun(ctx);
    const a = required();
    a.focus.advance();
    // Pi's own prompt sections (AGENTS.md files, skills, cwd) stay; the profile's instructions go last.
    syncSearch(a.config);
    syncRouterTools(pi, a.config.routerMode);
    const router = `${a.config.routerMode ? `\n\n${ROUTER_DOC}` : ''}${a.config.managerMode ? `\n\n${MANAGER_DOC}` : ''}`;
    event.systemPromptOptions.customPrompt = allowSearch(`${PROMPT}${a.config.previousExchange ? CONTINUITY : ''}${a.config.memorySearch ? SEARCH_DOC : ''}${NAVIGATION_DOC}${router}`, a.config.memorySearch);
    const lessons = dreamLessons.get();
    event.systemPromptOptions.sections.instructions = `${instructions(a.dir)}\n\n${IMPORT_GUIDANCE}${lessons ? `\n\n${lessons}` : ''}`;
    prompt = event.systemPrompt;
    const summary = briefDream(ctx);
    if (summary) ctx.ui.notify(summary, 'info');
    const note = event.messageType === 'user' ? skillInvocationNote(event.prompt) : undefined;
    a.metrics.record('start', performance.now() - started);
    if (note) return { message: { customType: SKILL_INVOCATION_TYPE, content: note, display: false } };
  });
  const DUPLICATE_REPORT = '(duplicate report, already delivered)';
  pi.on('message_end', async (event, ctx) => {
    turn.push(event.message);
    if (event.message.role === 'assistant' && event.message.stopReason === 'error') outage?.note(event.message.errorMessage, event.message.provider);
    if (heartbeat?.waking) {
      const original = event.message;
      if (original.role === 'assistant') {
        // A tell that resumes a finished worker launches it again, as a spawn does: the wake waits for its report too.
        for (const block of original.content) if (block.type === 'toolCall' && (block.name === 'spawn' || block.name === 'tell')) wakeWorkers.called(block.id);
        if (original.stopReason === 'stop') wakeWorkers.replied();
      } else if (original.role === 'toolResult' && (original.toolName === 'spawn' || original.toolName === 'tell')) {
        wakeWorkers.result(original.toolCallId, (original.details as { runIds?: unknown } | undefined)?.runIds, original.isError);
        for (const report of reports) if (wakeWorkers.hasReport(report.text) && !report.awaitingProcessing) {
          report.awaitingProcessing = true; saveReports();
        }
      } else if (original.role === 'custom' && original.customType === REPORT_TYPE) {
        const text = textContent(original.content);
        if (reports.some(r => (r.runIds || r.workerRecovery) && r.text === text)) {
          wakeWorkers.observed(text);
          if (wakeWorkerContext) watchWakeWorkers(wakeWorkerContext);
        }
      }
    }
    if (event.message.role === 'assistant' && event.message.stopReason === 'stop')
      for (const report of reports) if (report.awaitingProcessing && report.observed) report.responded = true;
    if (!active || !runStarted) return;
    // Shell evidence stays exact in the session; only the provider projection is reduced.
    const shell = event.message.role === 'toolResult' && ['bash', 'powershell'].includes(event.message.toolName);
    const bounded = active.config.recoverableOutput && (shell || active.outputs.preserveOriginal(event.message)) ? event.message : boundedMessage(event.message);
    const message = asUser(bounded);
    if (event.message.role === 'toolResult') fullToolResults.set(message, event.message);
    // Before the message is logged, so the image its text names is already there for zoom; zoom's own images are kept already.
    if (message.role === 'user' || message.role === 'toolResult' && message.toolName !== 'zoom') {
      try { await saveImages(active.memory.store, message.content); }
      catch (error) { ctx.ui.notify(`OptChat could not keep an image: ${errorText(error)}`, 'warning'); }
    }
    if (!active) return;
    if (message.role === 'user') {
      try {
        const text = textContent(message.content);
        // A report is shown as our custom message, or sent as plain text before the first run has a prompt to reuse.
        if (bounded.role === 'custom' && bounded.customType === REPORT_TYPE || bundles.has(text) || reports.some(r => !r.batch && r.text === text)) {
          // A report sent again after a lost steer can still arrive twice (Pi kept the old steer after an abort): drop the extra copy.
          // Copies are counted, so a later report that happens to repeat an earlier text still arrives.
          const receipt = reportReceipt(text), copies = run.slice(logged).filter(m => receipts.get(m) === receipt).length;
          const carried = bundles.get(text), pending = reports.find(r => !r.batch && r.text === text);
          // A bundle is a copy once every report it carries is logged, or when its message is already in this run.
          if (carried && (copies > 0 || !carried.some(r => reports.includes(r))))
            return { message: bounded.role === 'custom' ? { ...bounded, content: DUPLICATE_REPORT, display: false } : { ...message, content: DUPLICATE_REPORT } };
          if (carried) bundled.set(message, carried);
          else if (pending?.awaitingProcessing && pending.observed ||
            reports.filter(r => !r.batch && r.text === text).length <= copies && (copies > 0 || !pending?.awaitingProcessing && active.memory.root.some(e => e.receipt === receipt)))
            return { message: bounded.role === 'custom' ? { ...bounded, content: DUPLICATE_REPORT, display: false } : { ...message, content: DUPLICATE_REPORT } };
          if (!carried && pending?.awaitingProcessing) pending.observed = true;
          receipts.set(message, receipt);
        } else {
          // The inbox journaled the typed input: match without image references or Pi's image notes.
          const typed = typedText(message.content), skill = parseSkillBlock(typed.bare);
          let receipt = active.inbox.claim(typed.text) ?? active.inbox.claim(typed.bare)
            ?? (skill ? active.inbox.claimSkill(skill.name, skill.userMessage) : undefined);
          if (!receipt) { active.inbox.record(text); receipt = active.inbox.claim(text); }
          if (receipt) receipts.set(message, receipt);
        }
      } catch (error) { ctx.abort(); fault = errorText(error); ctx.ui.notify(fault, 'error'); }
    }
    run.push(message);
    if (view !== undefined) {
      try { flush(); } catch (error) { ctx.abort(); fault = errorText(error); ctx.ui.notify(fault, 'error'); }
    }
    if (bounded !== event.message) return { message: bounded };
  });
  const memoryView = async (ctx: ExtensionContext, signal = ctx.signal) => {
    const a = required();
    let shown: string | undefined;
    const show = () => {
      const error = a.memory.lastError;
      const text = `Waiting for OptChat summaries…${error ? ` failing: ${oneLine(error)}${error.includes('/optchat') ? '' : ' (see /optchat model)'}` : ''}`;
      if (text !== shown) ctx.ui.setWorkingMessage(shown = text);
    };
    show();
    const unsubscribe = a.memory.onChange(show);
    const started = performance.now();
    try { await a.memory.settle(signal); } finally { a.metrics.record('settle', performance.now() - started); unsubscribe(); ctx.ui.setWorkingMessage(); }
    return a.memory.render();
  };
  pi.on('context_with_system', async (event, ctx) => {
    const contextStarted = performance.now();
    try {
      if (!active) return; // Plain Pi run: pass context through unmodified.
      const a = required();
      if (importing || pendingImport(a.dir)) throw new Error('Profile is unavailable while importing.');
      if (fault) throw new Error(fault);
      if (view === undefined) {
        const memoryStarted = performance.now();
        if (lastRequestAt === undefined || Date.now() - lastRequestAt >= coldAfter(ctx.model)) a.memory.cool();
        view = await memoryView(ctx); // Capture old history before logging the new input.
        focusView = a.focus.render(a.memory);
        flush();
        a.metrics.record('memory', performance.now() - memoryStarted);
      }
      // Later extensions (including MCP) may add system-prompt sections; keep Pi's current prompt when our preamble is present.
      const current = ctx.getSystemPrompt();
      if (current.startsWith(PROMPT.slice(0, 40))) prompt = current;
      const system = stateless(promptFor(prompt, a.config));
      if (records?.epoch !== viewEpoch) {
        const operationalStarted = performance.now();
        const operational = readOperationalState(join(a.dir, 'operational-state.json'));
        const digest = a.config.situationDigest ? situation?.forRun(runSeq) : undefined;
        records = { epoch: viewEpoch, text: [digest ?? '', operational.entries.length ? renderOperationalContext(operational) : '', commitments.context(a.dir), catchup.context()].filter(Boolean).join('\n\n') };
        a.metrics.record('operational', performance.now() - operationalStarted);
      }
      system.state = [system.state, a.operations.context(), records.text].filter(Boolean).join('\n\n');
      const window = ctx.model?.contextWindow;
      const inputBudget = window ? inputTokenBudget(window, ctx.model?.maxTokens) : undefined;
      const statusLine = atWork(board?.view(12), deploy.active());
      const projectionStarted = performance.now();
      const projectedRun = a.config.recoverableOutput ? a.outputs.project(run) : run;
      a.metrics.record('projection', performance.now() - projectionStarted);
      // After a pause that expired the turn's cache entry, moving the turn into memory costs nothing extra.
      const refresh = refreshPoint(projectedRun, keep, coldBudget(refreshBudget(window, refreshFraction(a.config.refreshAt), refreshTokens(a.config.refreshTokensK)),
        lastRequestAt === undefined ? undefined : Date.now() - lastRequestAt));
      const budgetStarted = performance.now();
      let budgeted = inputBudget === undefined ? undefined
        : budgetContext(a.memory, event.messages, refreshedRun(projectedRun, keep, TURN_REFRESHED), view, system.prompt, inputBudget, previous, system.state, statusLine, focusView);
      a.metrics.record('budget', performance.now() - budgetStarted);
      if (refresh || budgeted && !budgeted.fits) {
        const cut = refresh?.cut ?? lastStep(run);
        if (cut > keep) {
          const size = refresh?.size ?? run.slice(keep, cut).reduce((sum, message) => sum + messageChars(message), 0), began = Date.now();
          ctx.ui.setWorkingMessage(`OptChat: moving this turn's ${Math.round(size / 4000)}k tokens into memory…`);
          try { flush(); await a.memory.settle(ctx.signal); } finally { ctx.ui.setWorkingMessage(); }
          if (!a.memory.ready) throw new Error('OptChat cannot refresh this run while summaries are missing. Originals are preserved; fix the compactor and continue in a new turn.');
          view = a.memory.render(); focusView = a.focus.render(a.memory); keep = cut; viewEpoch++;
          ctx.ui.notify(`OptChat moved ${Math.round(size / 4000)}k tokens of this turn into memory (${((Date.now() - began) / 1000).toFixed(1)}s).`, 'info');
          budgeted = inputBudget === undefined ? undefined
            : budgetContext(a.memory, event.messages, refreshedRun(projectedRun, keep, TURN_REFRESHED), view, system.prompt, inputBudget, previous, system.state, statusLine, focusView);
        }
      }
      const compat: Record<string, unknown> = record(ctx.model?.compat) ? ctx.model.compat : {};
      const assembleStarted = performance.now();
      const messages = stableHead.apply(
        budgeted?.messages ?? buildContext(event.messages, refreshedRun(projectedRun, keep, TURN_REFRESHED), view, system.prompt, previous, system.state, statusLine, focusView),
        { model: `${ctx.model?.provider}/${ctx.model?.id}`, native: nativeHead(compat),
          cold: lastRequestAt === undefined || Date.now() - lastRequestAt >= coldAfter(ctx.model), epoch: viewEpoch,
          sections: getCurrentSystemMessage(event.messages)?.sections ?? {} });
      const head = stableHead.saved();
      // Written when the head is rewritten with other content; a cold rewrite of the same head adds nothing.
      if (head && head !== savedHead) {
        if (!savedHead || JSON.stringify(head) !== JSON.stringify(savedHead)) writeHeadFile(a.dir, a.sessionId, head);
        savedHead = head;
      }
      a.metrics.record('assemble', performance.now() - assembleStarted);
      if (window) assertContextFits(messages, window, ctx.model?.maxTokens);
      const telemetryStarted = performance.now();
      a.metrics.context(messages);
      a.metrics.record('telemetry', performance.now() - telemetryStarted);
      return { messages };
    } catch (error) {
      // Pi catches extension errors. Explicitly abort so it cannot fall back to old context.
      ctx.abort();
      try { flush(); } catch (persistenceError) { fault = errorText(persistenceError); }
      ctx.ui.notify(errorText(error), 'error');
      return { messages: [{ role: 'system', content: 'OptChat context unavailable. Stop.', timestamp: 0 }] };
    } finally { active?.metrics.record('context', performance.now() - contextStarted); }
  });
  pi.on('before_provider_request', (event, ctx) => {
    if (active) lastRequestAt = Date.now();
    const started = performance.now();
    const payload = ctx.model?.api === 'anthropic-messages' ? cachePayload(event.payload, { prefix: prefixRetention(ctx.model), entries: viewEntries }) : event.payload;
    active?.metrics.record('provider_hook', performance.now() - started);
    return payload;
  });
  pi.on('cache_warming_decision', () => ({ action: 'stop' }));
  pi.on('session_before_compact', async (event, ctx) => {
    if (!active) return; // Unbound Pi keeps its own compaction policy.
    try {
      flush();
      const summary = await memoryView(ctx, event.signal);
      if (!active.memory.ready) throw new Error('OptChat summaries are missing; refusing to replace unsummarized history. See compactor-diagnostics.jsonl.');
      // Pi needs a real boundary to clear stale usage/overflow recovery. Store the existing tree view, never a second lossy summary.
      return { compaction: { summary, firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore, details: { optchat: true } } };
    } catch (error) {
      ctx.ui.notify(errorText(error), 'error');
      return { cancel: true };
    }
  });
  const collectUsage = (ctx: ExtensionContext) => {
    const started = performance.now();
    try { active?.usage.backfill(ctx.sessionManager.getEntries(), ctx.sessionManager.getSessionId()); }
    catch (error) { ctx.ui.notify(`Could not save usage: ${errorText(error)}`, 'error'); }
    finally { active?.metrics.record('usage', performance.now() - started); }
  };
  pi.on('turn_end', (_event, ctx) => collectUsage(ctx));
  const watchWakeWorkers = (ctx: ExtensionContext) => {
    wakeWorkerContext = ctx;
    if (wakeWorkerTimer) clearTimeout(wakeWorkerTimer);
    if (!wakeWorkers.holding || !Number.isFinite(wakeWorkers.deadline)) return;
    wakeWorkerTimer = setTimeout(() => {
      wakeWorkerTimer = undefined;
      if (!active || stopping || !heartbeat?.waking) return;
      const expired = wakeWorkers.expire();
      if (!expired) { watchWakeWorkers(ctx); return; }
      ctx.ui.notify(WORKER_UNVERIFIED, 'warning');
      wakeRetried = true;
      // The worker transcript retains the original. Unknown transport is not permission to replay it.
      if (expired === 'recover') {
        void deliverReport(WORKER_RECOVERY, { workerRecovery: true }).catch(error => ctx.ui.notify(`Worker recovery dispatch failed: ${errorText(error)}`, 'error'));
        watchWakeWorkers(ctx);
      } else if (idle()) {
        reports = reports.filter(r => !r.workerRecovery); saveReports();
        const messages = [...heldWakeMessages, ...turn];
        const summary = heartbeat.combine(summarizeTurn(messages));
        heartbeat.turnSettled({ ...summary, reply: WORKER_UNVERIFIED, stopReason: 'error' });
        working = false; showTitle(ctx);
        void slack.runEnded(messages, WORKER_UNVERIFIED);
        void wakeOff(active.dir, wakeHost(ctx)).catch(error => ctx.ui.notify(`Could not restore the main model: ${errorText(error)}`, 'error'));
        clearWakeWorkers(); heartbeat.arm();
      }
    }, Math.max(0, wakeWorkers.deadline - Date.now()));
    wakeWorkerTimer.unref?.();
  };
  pi.on('agent_settled', async (_event, ctx) => {
    const settledStarted = performance.now();
    collectUsage(ctx);
    const persistenceStarted = performance.now();
    try { flush(); appendPeerCopies(); active?.inbox.dropReturned(); } catch (error) { fault = errorText(error); ctx.ui.notify(fault, 'error'); }
    finally { active?.metrics.record('persistence', performance.now() - persistenceStarted); }
    const retryReports = reports.filter(r => !r.batch && !r.workerRecovery &&
      (r.steered && !wakeWorkers.hasReport(r.text) || _event.aborted && r.awaitingProcessing && (r.steered || r.observed)));
    if (runStarted) pi.appendEntry(RUN_BOUNDARY, { state: 'end' });
    runStarted = false; status(ctx);
    if (!_event.aborted) {
      const completed = new Set(wakeWorkers.completedReports());
      const remaining = reports.filter(r => !completed.has(r.text) && !(r.awaitingProcessing && r.responded));
      if (remaining.length !== reports.length) { reports = remaining; saveReports(); }
    }
    wakeWorkers.settled(_event.aborted);
    if (_event.aborted) for (const r of reports) { r.observed = false; r.responded = false; }
    // A lost steer or an aborted processing turn may redeliver the report, never the worker's effects.
    if (active && !fault && !stopping) sendReports(retryReports.filter(r => reports.includes(r)));
    if (wakeWorkers.notVerified && !wakeWorkers.holding) {
      reports = reports.filter(r => !r.workerRecovery); saveReports();
    }
    const waitingWorkers = heartbeat?.waking && wakeWorkers.holding && !fault && !stopping;
    working = !!waitingWorkers; showTitle(ctx);
    settledAt = Date.now();
    const messages = [...heldWakeMessages, ...turn];
    const wake = heartbeat?.waking ? heartbeat.combine(summarizeTurn(messages)) : undefined;
    if (wake && wakeWorkers.notVerified) wake.reply = `${WORKER_UNVERIFIED} ${wake.reply}`;
    // A wake that did not work (a memory-line reply, or no commit, push, PR or merge) is sent back once; the wake stays open
    // (same model, same record) for the run that delivers.
    const reload = wake && active && !fault && !stopping ? selfReload.ready(ctx, _event.aborted) : undefined;
    if (reload && active) { heartbeat?.holdReload(reload, Date.now() + HOLD_MAX_MS, wake); watchWakeReload(reload, ctx, active); }
    const waitingReload = wake && !fault && !stopping && !_event.aborted && wake.stopReason !== 'error' && heartbeat?.awaitingReload;
    const retry = wake && !waitingReload && !waitingWorkers && !wakeRetried && !fault && !stopping ? wakeRetry(wake) : undefined;
    if (waitingWorkers) { watchWakeWorkers(ctx); if (!_event.aborted) await slack.answerDuringHold(); }
    else if (waitingReload) { /* The ticket owns the next turn; a request is not a delivery. */ }
    else if (retry) { wakeRetried = true; void deliverReport(retry); }
    else {
      heartbeat?.turnSettled({ ...wake ?? summarizeTurn(turn), ...ctx.model && { model: `${ctx.model.provider}/${ctx.model.id}` } });
      if (active) await wakeOff(active.dir, wakeHost(ctx)).catch(error => ctx.ui.notify(`Could not restore the main model after the wake: ${errorText(error)}`, 'error'));
      if (active && !fault && !stopping) heartbeat?.arm();
      await slack.runEnded(messages, wakeWorkers.notVerified ? WORKER_UNVERIFIED : undefined);
      clearWakeWorkers();
    }
    if (waitingWorkers || waitingReload || retry) heldWakeMessages = messages;
    if (active) {
      const dir = active.dir;
      const metrics = active.metrics, statusStarted = performance.now();
      void active.sync.now();
      metrics.record('status', performance.now() - statusStarted);
      checkpoints = checkpoints.then(() => checkpoint(dir)).catch(error => ctx.ui.notify(`Local checkpoint failed: ${errorText(error)}`, 'error'));
      const checkpointStarted = performance.now();
      await checkpoints;
      metrics.record('checkpoint', performance.now() - checkpointStarted);
    }
    active?.metrics.record('settled', performance.now() - settledStarted);
  });
  const selfReload = registerSelfReload(pi, () => {
    if (!active) return undefined;
    const blockers = [
      (stopping || fault) && 'Profile is closing or has a persistence fault.',
      (remote || joined) && 'Reload belongs to the original local session, not a connected window.',
      (importing || pendingImport(active.dir)) && 'Finish or close the import first.',
      active.children.active && 'OptChat subagents are active; wait for their completion.',
      reportsBlockReload(reports, Date.now(), r => !!outage?.holds(r as Report)),
      active.operations.blockReason('self_reload'),
    ];
    return { profile: active.name, blocked: blockers.find((reason): reason is string => typeof reason === 'string') };
  }, async () => { flush(); await checkpoints; await checkpoint(required().dir); });
  registerConnectedRenderer(pi);
  registerReportRenderer(pi);
  const [zoom, date] = memoryTools(() => required().memory, id => required().children.transcript(id), ref => required().focus.observe(ref));
  pi.registerTool(zoom); pi.registerTool(date);
  pi.registerTool(outputReadTool(() => required().outputs));
  pi.registerTool(readManyTool(process.cwd()));
  pi.registerTool({ ...performanceTool(() => required().metrics, () => required().outputs.stats()), defaultActive: false });
  pi.registerTool({ ...machineTool(machineService, () => situation), defaultActive: false });
  pi.registerTool({ ...heapReportTool(() => active && { memory: active.memory.stats(), run: run.length, reloads: reloadCount() }), defaultActive: false });
  registerToolInventory(pi);
  registerLiveResources(pi);
  pi.registerCommand('optchat-perf', { description: 'Show numeric diagnostics; payload on/off enables optional actual-payload byte measurements (no model call)',
    handler: async (args, ctx) => {
      const a = required(), option = args.trim();
      if (option === 'payload on' || option === 'payload off') a.metrics.measurePayload(option === 'payload on');
      else if (option) throw new Error('Usage: /optchat-perf [payload on|payload off]');
      ctx.ui.notify(JSON.stringify({ ...a.metrics.snapshot(), output: a.outputs.stats() }, null, 2), 'info');
    } });
  pi.registerTool(operationalStateTool(required, flush));
  pi.registerTool({ ...searchTool(() => required().memory), defaultActive: false });
  // The tool and its prompt line change together, once per toggle, so the cached prefix is otherwise stable.
  // Synced on save too: a report turn started while idle reuses the tool set without before_agent_start.
  const syncSearch = ({ memorySearch, managerMode }: ProfileConfig) => {
    let tools = pi.getActiveTools();
    const toggle = (name: string, on: boolean) => { if (tools.includes(name) !== on) tools = on ? [...tools, name] : tools.filter(t => t !== name); };
    const before = tools;
    toggle('search', memorySearch); toggle('crew', managerMode); // The crew tool is declared only in manager mode.
    if (tools !== before) pi.setActiveTools(tools);
  };
  pi.registerTool({ ...crewTool(() => required().crew, () => ({ commitmentsDir: required().dir })), defaultActive: false });
  pi.registerTool({ name: 'spawn', label: 'Spawn background agents',
    description: 'Start background subagents, returning IDs immediately. Use only when the user asks, or in manager mode for a worker: a task with `kind` must be a contract (lines Goal:, Acceptance:, Evidence:, Authority:) and gets its project\'s charter and memory instead of the chat. The result names the model of each worker (`kind` picks the tier in your own provider family and account; `model`, provider/model, overrides it with any account). Give each task the cwd of the project it works on, so the subagent starts there with that project\'s AGENTS.md. Each receives the current memory view and read-only zoom/date. Whether children may delegate further, and how many agents may run at once, is set per profile. Completion reports arrive automatically; never poll or sleep waiting for them.',
    parameters: childToolSchemas.spawn,
    async execute(_id, args, signal, _update, ctx) {
      let runIds: string[] = [];
      const text = await required().children.start(args.tasks, ctx.cwd, signal, undefined, ids => {
        runIds = ids;
        if (heartbeat?.waking) wakeWorkers.launched(_id, ids);
      }); status(ctx);
      return { ...result(text), details: { runIds } };
    },
  });
  pi.registerTool({ name: 'tell', label: 'Tell background agent', description: 'Message a subagent: running gets it at its next tool boundary, finished resumes and reports.',
    parameters: childToolSchemas.tell,
    async execute(_id, args) {
      const children = required().children, before = children.live(args.id) ? undefined : children.info(args.id)?.started;
      const text = await children.tell(args.id, args.message), after = children.info(args.id);
      // Resumed: it was finished and now runs, or already ran again (a new start), so its report is owed to this turn.
      const resumed = before !== undefined && after !== undefined && (children.live(args.id) !== undefined || after.started !== before);
      if (resumed && heartbeat?.waking) wakeWorkers.launched(_id, [args.id]);
      return { ...result(text), details: resumed ? { runIds: [args.id] } : {} };
    },
  });

  /** The settings page's options: every model Pi is logged in to, with the thinking levels it takes, sorted so each provider's models sit together. */
  const settingsOptions = (ctx: ExtensionContext, a: Active) => ({ profile: a.name, config: a.config, main,
    models: ctx.modelRegistry.getAvailable().map(m => ({ name: `${m.provider}/${m.id}`, thinking: getSupportedThinkingLevels(m) })).sort((x, y) => x.name.localeCompare(y.name)),
    save: (config: ProfileConfig) => { saveConfig(a.dir, config); syncSearch(config); syncRouterTools(pi, config.routerMode); setImmediate(() => a.sync.schedule()); } });
  const pickModel = async (ctx: ExtensionContext, role: 'compactor' | 'subagent') => {
    const a = required();
    if (ctx.mode !== 'tui') throw new Error('Choosing a model requires interactive Pi. Edit config.json in the profile directory instead.');
    const choice = await showModelPicker(ctx, role, settingsOptions(ctx, a));
    if (choice) ctx.ui.notify(`${role}: ${choice.provider}/${choice.model} (${choice.thinking}); applies to new calls.`, 'info');
  };
  /** Per-provider fallbacks for a role: what it runs while the main model is on another provider. */
  const pickFallbacks = async (ctx: ExtensionContext, role: 'compactor' | 'subagent') => {
    const a = required();
    if (ctx.mode !== 'tui') throw new Error('Choosing a fallback requires interactive Pi. Edit "alternates" in the profile config.json instead.');
    await showFallbacks(ctx, role, settingsOptions(ctx, a));
  };
  const inspect = async (ctx: ExtensionContext, page: InspectorPage) => {
    if (inspectorController) return;
    const controller = new AbortController();
    try {
      const a = required();
      if (ctx.mode !== 'tui') throw new Error('The inspector requires interactive Pi.');
      if (importing) throw new Error('Close the import dialog before opening the inspector.');
      inspectorController = controller;
      const signal = inspectorController.signal;
      const action = await showInspector(ctx, { profile: a.name, session: ctx.sessionManager.getSessionId(), children: a.children, usage: a.usage, memory: a.memory, shells, page, signal,
        refreshUsage: () => { collectUsage(ctx); try { a.children.collectUsage(); } catch (error) { ctx.ui.notify(`Could not save child usage: ${errorText(error)}`, 'error'); } },
      });
      if (signal.aborted) return;
      if (action === 'model') await pickModel(ctx, 'subagent');
      else if (action) await showAgentView(ctx, { id: action.open, children: a.children, signal });
    } catch (error) { ctx.ui.notify(errorText(error), 'error'); }
    finally { if (inspectorController === controller) inspectorController = undefined; }
  };
  pi.registerShortcut(shortcut, { description: 'Inspect OptChat agents, usage and background activity', handler: ctx => inspect(ctx, 'agents') });
  const command = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
    if (remote && !remote.ended) { ctx.ui.notify('Manage this profile in its original window. Here use /tell-main or /complete.', 'info'); return; }
    if (importing) throw new Error('Close the import dialog before changing profile settings.');
    let action = args.trim();
    if (!action) {
      const a = active;
      action = await showMenu(ctx, brand, a && { profile: a.name, messages: a.memory.root.length, pending: a.memory.pending,
        compactor: a.config.compactor, agents: a.config.subagent, error: a.memory.lastError,
        compactorLabel: roleModel(a.config, 'compactor', main), agentsLabel: roleModel(a.config, 'subagent', main) }) ?? '';
    }
    if (action === 'catchup' || action.startsWith('catchup ')) return catchup.command(action.slice('catchup'.length).trim(), ctx);
    if (action === 'retry-summary' || action.startsWith('retry-summary ')) {
      await retrySummary(required().memory, action.slice('retry-summary'.length), ctx); return;
    }
    if (action === 'import') {
      const a = required();
      if (!ctx.hasUI) throw new Error('/optchat import requires interactive Pi.');
      if (!ctx.isIdle() || a.children.active || reports.length) throw new Error('Finish active work and pending reports before importing.');
      importing = true; importController = new AbortController(); let closed = false;
      status(ctx);
      const signal = importController.signal;
      importTask = (async () => {
        let job = pendingImport(a.dir);
        if (job) {
          const selected = await ctx.ui.select(`Paused ${job.mode} import · ${job.added} new messages`, ['Resume import', 'Discard staged import', 'Cancel'], { signal });
          if (selected === 'Discard staged import') {
            if (await ctx.ui.confirm('Discard import?', 'Original memory stays unchanged. Staged summaries will be removed.', { signal })) { signal.throwIfAborted(); discardImport(a.dir); }
            return;
          }
          if (selected !== 'Resume import') return;
        } else {
          const plan = await chooseImport(ctx, a.name, a.memory, `${a.config.compactor.provider}/${a.config.compactor.model} (${a.config.compactor.thinking})`, signal);
          if (!plan) return;
          signal.throwIfAborted();
          flush(); a.inbox.recover(a.memory); await checkpoints; await a.memory.close('import'); closed = true;
          signal.throwIfAborted();
          job = prepareImport(a.dir, a.memory, plan.entries, plan.mode);
          if (!job) return;
        }
        if (!closed) { await a.memory.close('import'); closed = true; }
        const compress = createCompressor(ctx.modelRegistry, () => modelFor(a.config, 'compactor', main), message => {
          a.usage.compression(message, 'import', ctx.sessionManager.getSessionId());
        }, () => a.config.summaryAcceptBytes, shared);
        const completed = await showProgress(ctx, job, (signal, progress) => runImport(a.dir, compress, signal, a.config.importJobs, progress), signal);
        ctx.ui.notify(completed ? `Imported ${job.added} messages into ${a.name}. Previous memory retained at ${job.previous === '.' ? a.dir : join(a.dir, job.previous)}.`
          : 'Import paused. Use /optchat import to resume. Other profiles remain available.', 'info');
      })();
      let failure: unknown;
      try { await importTask; } catch (error) { failure = error; }
      finally { importing = false; importTask = undefined; importController = undefined; ctx.ui.setWidget('optchat-import', undefined); }
      if (closed && !stopping) await ctx.newSession({ setup: async manager => { manager.appendCustomEntry(binding, { name: a.name }); } });
      else status(ctx);
      if (failure) throw failure;
      return;
    }
    const named = /^profile\s+(\S+)$/.exec(action)?.[1];
    if (ctx.mode !== 'tui' && (named || action === 'profile')) {
      // RPC and SDK hosts (Pi Web) have no picker and may not support ctx.newSession(), so a still-empty session binds in place.
      const first = `Run /optchat profile ${named ?? '<name>'} as the first message of a new session, or start Pi with --optchat-profile <name>.`;
      if (!named || active || remote || joined || ctx.sessionManager.getEntries().some(e => e.type === 'message' || e.type === 'custom_message')) throw new Error(first);
      // As with a requested profile: one that fails to open blocks prompts instead of running without memory.
      try { await openProfile(named, ctx); } catch (error) { fault = errorText(error); throw error; }
      pi.appendEntry(binding, { name: named });
      return;
    }
    if (action === 'profile') {
      if (!ctx.isIdle() || active?.children.active) throw new Error('Finish or stop active work before switching profiles.');
      const selected = await chooseProfile(ctx);
      if (!selected || selected === active?.name) return;
      await ctx.newSession({ setup: async manager => { manager.appendCustomEntry(binding, { name: selected }); } });
      return;
    }
    if (action === 'settings') {
      const a = required();
      if (ctx.mode !== 'tui') throw new Error('/optchat settings requires interactive Pi. Edit config.json in the profile directory instead.');
      return showSettings(ctx, settingsOptions(ctx, a));
    }
    if (action === 'model') return pickModel(ctx, 'compactor');
    if (action === 'agents model') return pickModel(ctx, 'subagent');
    if (action === 'fallback') return pickFallbacks(ctx, 'compactor');
    if (action === 'agents fallback') return pickFallbacks(ctx, 'subagent');
    if (action === 'agents' || action === 'usage' || action === 'activity' || action === 'shells') return inspect(ctx, action);
    if (action === 'instructions') {
      const a = required();
      const edited = await ctx.ui.editor(`${a.name} · AGENTS.md`, instructions(a.dir));
      if (edited !== undefined) { atomicWrite(join(a.dir, 'AGENTS.md'), edited); ctx.ui.notify('Saved. Applies to the next turn and newly spawned agents.', 'info'); }
      return;
    }
    if (action === 'browse') {
      const a = required(), file = exportBrowser(a.memory, a.name, a.dir);
      // explorer.exe exits 1 even when it opened the file, so only its launch failing counts there.
      if (ctx.hasUI) execFile(isWindows ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open', [file], error => { if (error && (!isWindows || error.code === 'ENOENT')) ctx.ui.notify(`Open ${file}`, 'info'); });
      ctx.ui.notify(file, 'info'); return;
    }
    if (action) throw new Error('Use /optchat [catchup|profile|settings|model|fallback|agents|agents model|agents fallback|usage|activity|shells|instructions|browse|import].');
  };
  pi.registerCommand('complete', { description: 'End this connected conversation and hand off to the main agent', handler: async (_args, ctx) => {
    if (!remote) { ctx.ui.notify('/complete is for connected subagent windows.', 'info'); return; }
    try { await remote.complete(); } catch (error) { ctx.ui.notify(errorText(error), 'error'); }
  } });
  pi.registerCommand('tell-main', { description: 'Send a message to the main agent from this connected window', handler: async (args, ctx) => {
    if (!remote) { ctx.ui.notify('/tell-main is for connected subagent windows.', 'info'); return; }
    try { await remote.tell(args); } catch (error) { ctx.ui.notify(errorText(error), 'error'); }
  } });
  pi.registerCommand('heartbeat', { description: 'Heartbeat: wakes today and the wake budget left; "queue" lists and "add <text>" appends to the idle-time work queue',
    getArgumentCompletions: prefix => ['report', 'queue', 'add'].filter(s => s.startsWith(prefix)).map(value => ({ value, label: value })),
    handler: async (args, ctx) => {
      try {
        const a = required();
        ctx.ui.notify(heartbeatCommand(args, { dir: a.dir, now: Date.now(), cap: a.config.heartbeatWakes, minutes: a.config.heartbeatMinutes }), 'info');
      } catch (error) { ctx.ui.notify(errorText(error), 'error'); }
    } });
  pi.registerCommand('optchat', { description: 'OptChat profiles, settings, models, agents, instructions, memory browser, and imports',
    getArgumentCompletions: prefix => ['catchup', 'profile', 'settings', 'model', 'fallback', 'agents', 'agents model', 'agents fallback', 'usage', 'activity', 'shells', 'instructions', 'browse', 'import', 'retry-summary'].filter(s => s.startsWith(prefix)).map(value => ({ value, label: value })),
    handler: async (args, ctx) => { try { await command(args, ctx); } catch (error) { ctx.ui.notify(errorText(error), 'error'); } },
  });
}
