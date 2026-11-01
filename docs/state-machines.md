# State machines in pi-optchat

A catalog of the lifecycles in `src/` that are encoded by flags, nullable fields, timers or persisted JSON rather than by
one explicit model, what is wrong with each, and what this change did about it. Line numbers are from the branch
`refactor/state-machines` (commit that adds this file); they drift, the function names do not.

Severity: **P1** data loss, wrong external effect or a wedged host; **P2** a lost message, a dead loop, a wrong persisted
state or a crash on a reachable input; **P3** cosmetic, rare, or protected by a second mechanism.
Status: **fixed** (code + regression test that fails without the fix), **catalogued** (no code change, with the reason).

Fixed in this change: SM-F1 … SM-F5 (all P2). No P1 was found. Everything else is catalogued.

## Summary

| # | Machine | States | Explicit before | Explicit after | Findings |
|---|---------|--------|-----------------|----------------|----------|
| 1 | Shell job (`ShellJobs`) | running → stopping → completed / failed / stopped | yes (union, 3 writers) | same | none |
| 2 | Shell hand-off across `/reload` | held → adopted / closed | partly (global slot + version) | same | P3 |
| 3 | Reaping shell process (`exited`, `live`) | spawned → exited → quiet → settled | flags `done/gone/grace` | same | none |
| 4 | Shell output alerts (`OutputAlerts`) | open → window waiting → ended | flags | same | none |
| 5 | Memory node build (`Memory`) | unbuilt → busy → built / retry-wait / refused | derived from 5 maps | same | P3 ×2 |
| 6 | Memory writer (`writing`, `failed`, `stopped`) | open → failed / closed | flags | same | none |
| 7 | Heartbeat (`Heartbeat`) + wake log | idle(armed) → checking → waking → settled | partly (timer, epoch, open) | + round guard | **SM-F1** P2, P3 ×2 |
| 8 | Wake model restore (`wake-restore.json`) | main → switched → restored | file presence | same | P3 ×2 |
| 9 | Commitment item (`commitments.json`) | open / waiting_operator / blocked → done / dropped | union, unvalidated on read | + validated on read | **SM-F4** P2, P3 |
| 10 | Presence nudges (`Presence`) | clocks + two one-shot flags | flags | same | none |
| 11 | Self-reload ticket (`registerSelfReload`) | requested → reloading → resuming → completed / cancelled / failed | union, writers bypassed any table | transition table in `write` | **SM-F2** P2 |
| 12 | Slack bridge poll (`SlackBridge.poll`) | idle → polling → off-for | flags + timestamp | + `accepting` gate, catch | **SM-F3** P2, **SM-F5** P2 |
| 13 | Slack bridge run facets (`running/answering/waking`) | idle / running (+DM origin / +wake) | 3 flags | same (independent facets) | P3 |
| 14 | Slack approval posts (`approvals`) | posted → decided / expired / superseded | map + timers | same | P3 |
| 15 | Profile availability (`index.ts`) | none / remote / importing / closing / import-paused / open | 6 flags, 6 hand-written conjunctions | one derivation (`profilePhase`) | **SM-F3** P2 |
| 16 | Main run (`working`, `runStarted`, `view`, `keep`, `fault`) | idle → started → settled | 5+ fields | same | P3 |
| 17 | Sync lanes (`Sync`, `Lane`) | idle → draining → retry-after | flags + timestamp | same | none |
| 18 | Operation journal (`OperationJournal`) | started → response_recorded → reconciled | yes, validated | same | none |
| 19 | Effect approvals (`EffectApprovals`) | pending → approved (consumed) / denied / superseded / expired | map + boolean | same | P3 |
| 20 | Subagent run (`RunInfo.state`, `transition`) | running ⇄ waiting / paused → stopping → completed / failed / stopped / interrupted | yes (table) | same | none |
| 21 | Run guidance (`RunInfo.guidance[].state`) | queued → delivered / undelivered | union, 5 writers | same | P3 |
| 22 | `Children` counters (`closing`, `launching`, `resuming`, `deleting`, `settling`) | open → closing | counters/sets | same | none |
| 23 | pi-subagents RPC call (`SubagentRpc.call`) | waiting → resolved / rejected / timed out | `settled` flag | same | none |
| 24 | Connected-window connection (`serveWindows`) | new → attached / started → ending → closed | 5 flags per socket | same | P3 |
| 25 | Connected-window client (`openConnectedWindow`) | connecting → started → ended | flags | same | none |
| 26 | Import (`import/job.ts`) | prepared → running → activated → finished | journal + pointer file (validated) | same | none |
| 27 | Profile lock / lease (`holdProfile`) | free → held (+ heartbeat) → released | OS socket / store lease | same | P3 |
| 28 | Work tracker (`WorkTracker`) | per task: new → queued → working → ended | string status, flags | same | P3 |
| 29 | PR watch / morning summary / scoreboard (`slack-reports.ts`) | per day: unclaimed → claimed | file + timers | same | P3 |
| 30 | Production health round (`registerProdHealth`) | idle → busy | flag | same | P3 |
| 31 | Operational state grants (`operational-state.ts`) | active → superseded / expired | derived from append-only log, validated | same | none |
| 32 | Compactor retry and cache priming (`createCompressor`, `primeFirst`) | attempt → retry → done; cold → priming → warm | counters + map | same | P3 |
| 33 | Pending input journal (`Inbox`) | recorded → claimed → acknowledged / returned | sets + file | same | none |
| 34 | Catch-up windows (`CatchupWindows`) | none → cursor → spans | validated file | same | none |
| 35 | Heartbeat queue (`heartbeat-queue.md`) | open / done / blocked | markdown marks, parsed | same | none |
| 36 | UI views with `ended` (`AgentView`, `Inspector`, `LiveTurn`, `TabTitle`, `BarNavigation`) | live → disposed | one flag + interval | same | none |

---

## 1. Shell job — `src/shells.ts:38` (`ShellJobs`, `ShellJob.state`)

States: `running`, `stopping`, `completed`, `failed`, `stopped`. Lives in memory (`jobs` map, `controllers`, `tasks`).
Transitions (only three writers touch `state`):

| from | event | to | writer |
|------|-------|----|--------|
| – | `begin` | running | `begin` (:56) |
| running | `stop` | stopping | `stop` (:80) |
| running / stopping | `end` | completed / failed / stopped | `end` (:66), guarded by `job.ended !== undefined` so a second end is ignored |

Readers: `list`, `runningShells`, `endNoticeWanted`, `shellReport`, the work tracker, the status line.
Invariants: `ended` is set exactly once, together with the terminal state; `stop` is refused once `ended` is set or the
state is `stopping`; an end observed twice (tool event after the task result) is ignored; a job that was stopping ends
as `stopped` whatever the exit code. Eviction keeps active jobs.
Findings: none. Already explicit and correct; not refactored.

## 2. Shell hand-off across `/reload` — `src/shells.ts:114` (`handOffShells`, `adoptShells`)

State: one `Symbol.for` slot on `globalThis` holding `{version, profile, jobs}`, plus `reporter` / `unreported` inside
`ShellJobs`. `handOffShells` clears the reporter and stores the slot; `adoptShells` takes it once. Ends that arrive between
the two are queued in `unreported` and delivered by the next `setReporter`.
Findings:
- P3 (catalogued). A second `handOffShells` before an `adoptShells` silently replaces the slot, leaving the first
  `ShellJobs` running with no owner. Reachable only if two OptChat instances stop in one process before one starts; the
  reload path is strictly stop → start.

## 3. Reaping shell process — `src/shell-reaper.ts:74` (`exited`), `:112`

Flags `done`, `gone`, `grace` (timer) decide when a child counts as finished: `exit` → wait for pipes to be quiet → `close`
or grace expiry. `finish` is guarded by `done`, the `error` path sets `done` and clears the timer. `live` (a `Set` of pids) is
added to after spawn and removed in `finally`; the `process.once('exit')` hook kills what is left.
Findings: none. Every path clears the timer; resolve/reject after `done` are impossible.

## 4. Shell output alerts — `src/shell-alerts.ts:75` (`OutputAlerts`)

Fields `ended`, `batch`, `cancelTimer`, `lastSent`. `feed` after `end` is ignored; `end` is idempotent and flushes the last
batch; `send` cancels the pending timer; a batch is sent at most once per interval. `ShellJobs.alerted` ignores alerts
after the job's `ended`, and `runShell` calls `watch.end()` in `finally` *before* the job ends, so the last alert is not
lost.
Findings: none.

## 5. Memory node build — `src/memory.ts:137` (`Memory`), `:357` (`pump`), `:386` (`handleFailure`), `:436` (`build`)

One node (a message summary or a merge) is in exactly one of these states, derived from five containers:

| state | where it lives |
|-------|----------------|
| unbuilt | `unbuilt` (messages) or `merges` (both halves built) |
| busy | `busy` map |
| retry-wait | `retryAt` (a timestamp, `Infinity` without `retryMs`) |
| refused | `terminal` map, persisted as a terminal record |
| built | `tree` |

Events: `append` (clears all retry waits, keeps refusals), a failed build (`handleFailure`), a policy refusal, `retryRefused`
(explicit operator action), `close`. Timers: one `retryTimer` re-runs `pump` when the earliest wait is due.
Invariants: a refused node is never in `retryAt`; `loadTerminalRecords` drops refusals whose node exists; `pump` skips busy,
refused and waiting nodes; `close` aborts the controller, clears the timer and waits for `busy` and `writing`.
Findings:
- P3 (catalogued). `retryTimer` is not `unref`'d (:383, :397); a headless run that exits with a failed node waits up to
  `retryMs` for the timer. `close()` clears it, so only an unclosed Memory is affected.
- P3 (catalogued). Five containers encode one state; no code path puts a node in two of them for longer than the
  `busy → finally` gap, so no table was added.

## 6. Memory writer — `src/memory.ts:266` (`enqueue`), fields `writing`, `failed`, `stopped`

`failed` (first store error) makes later writes no-ops and later `append`s throw; `stopped` makes `append`, `retryRefused`,
`pump` and `handleFailure` refuse. `writing` is the tail of the write chain and clears itself.
Findings: none.

## 7. Heartbeat — `src/heartbeat.ts:245` (`Heartbeat`), `arm` :260, `fire` :296, `WakeRecord` :220

State: `timer` (armed or not), `running` (the round in flight), `epoch` (bumped when the operator speaks), `open` (the wake
whose turn has not settled), `failed` (check failure already noted). Persisted: `heartbeat.json` (`wakes`, `checks`,
`wakeLog`, `radarDigest`, `quietSkips`), validated field by field in `readSaved`.
Wake record outcome: `running` → `done` / `interrupted` / `error` / `unsettled`; written by `turnSettled`,
`operatorSpoke`, `unsettled()` (reload and next wake) through `amend`.

Events: `arm` (chat settled), `disarm` / `operatorSpoke` (turn started), timer fire, radar, check, wake, `turnSettled`.
Findings:
- **SM-F1, P2, fixed.** `arm` stored `this.fire()` as `this.running` with no handler. `fire` writes `heartbeat.json` through
  `atomicWrite` (`save`, `keep`, `amend`); on Windows a reader holding the file makes that rename fail (the same hazard
  `Sync.writeStatus` retries). The rejection ended the loop (`fire` is the only thing that re-arms after an idle round, so the
  heartbeat stayed dead until the next turn settled) and, unhandled, is a process-level `unhandledRejection`. Now the round
  runs through `fireOnce`: a throw is noted (`Heartbeat round failed: …`) and the clock is re-armed unless the operator
  spoke meanwhile (`epoch`). Test: `a round that cannot save heartbeat.json is noted and re-armed…` in
  `test/heartbeat.test.ts`.
- P3 (catalogued). After `deps.wake` the heartbeat stays disarmed until `agent_settled`. If `deliverReport` throws in the
  wake callback (`src/index.ts:329`), no turn starts, `open` stays set and nothing re-arms; the unsaved report also stays in
  `reports`, which makes `busy()` answer "reports queued" on every later round. It needs `pending-reports.json` to be
  unwritable at that moment; the next operator turn clears it.
- P3 (catalogued). `readSaved` keeps any `wakeLog` item with a numeric `at`; `outcome` and `trigger` are not checked against
  their unions. A hand-edited file shows odd text in `/heartbeat`; nothing branches on a wrong value except
  `quietReason` (`outcome !== 'done'`), which fails safe (wakes).

## 8. Wake model restore — `src/wake-model.ts:30` (`wakeOn`), `:46` (`wakeOff`)

State: presence of `wake-restore.json` (`provider/model/thinking` of the main model, `wake` of the wake model). `wakeOn`
writes it once (a wake while switched keeps the first record), `wakeOff` removes it after switching back, or drops it when the
session left the wake model on its own.
Findings:
- P3 (catalogued). A second wake with a *different* wake model while the first record is still there keeps the first
  record's `wake`, so `wakeOff` sees "the session left the wake model" and drops the record without switching back. Needs a
  failed restore followed by a wake-model change in `config.json`.
- P3 (catalogued). `saved()` checks `provider/model/thinking` but not `wake`; a malformed `wake` reads as "left the wake
  model" (`current.id !== undefined`) and drops the record. A corrupt JSON file throws from `wakeOn`/`wakeOff`, and both
  callers already notify.

## 9. Commitment item — `src/commitments.ts:19` (`STATUSES`), `readCommitments` :62, `addCommitment` :89, `updateCommitment` :111

States: `open`, `waiting_operator`, `blocked` (open family) and `done`, `dropped` (closed; kept 14 days, then pruned on write).
Lives in `commitments.json` (`version: 1`, items). Transitions: `add` (open, or waiting_operator for the operator),
`update` with any status (`done` needs evidence), `supersede` (old → dropped).
Readers: `commitmentsContext` (every turn), `summaryLines` (07:00 summary), `describe`, `attention`.
Findings:
- **SM-F4, P2, fixed.** `readCommitments` checked `version` and `Array.isArray(items)` only. An item with a status outside
  `STATUSES` is not `closed()`, so it read as open forever (every turn, every summary); an item without `notes` or with an
  unparsable time crashed `listText` / `updateCommitment` or printed `NaN` ages. Items are now validated on read, and a
  damaged file is "Unreadable commitments file" exactly like a bad version already was (visible in the turn block and the
  tool result, nothing is rewritten). Test: `a commitments file with an unknown status or a damaged item is unreadable…`.
- P3 (catalogued). `updateCommitment` allows any status transition, including reopening a `done` / `dropped` item, and
  refreshes `updatedAt` on a closed one (which extends its 14-day retention). The tool description lists all five statuses as
  settable, so reopening may be intended; it is not enforced either way.

## 10. Presence nudges — `src/commitments.ts:185` (`Presence`)

Two clocks (`reportedAt`, `provenAt`) and two one-shot flags (`nudged.report`, `nudged.stall`). `start` resets all; `reported`
and `progressed` reset one clock and its flag; `check` fires each nudge once per threshold. The two nudges are independent
facets, not one state. Findings: none.

## 11. Self-reload ticket — `src/self-reload.ts:45` (`registerSelfReload`), `write` :61

States: `requested` → `reloading` → `resuming` → `completed`, with `cancelled` and `failed` as the other ends. Lives in the
session as `optchat.self-reload` custom entries (the newest wins, validated in `saved`) and in the closure (`pending`,
`commandSent`, `continuationStarted`); a `leases` map on `globalThis` carries ownership across the reload.

| from | event | to |
|------|-------|----|
| requested | tool call | (new ticket) |
| requested | settled turn, command delivered, `prepare` ok | reloading |
| requested | operator input, blocked, session changed | cancelled |
| requested | `prepare` throws | failed |
| reloading | fresh runtime claims the lease | resuming |
| reloading | lease not confirmed | cancelled |
| resuming | continuation turn settles | completed / failed |
| resuming | operator input, another run, interrupted | cancelled |

Findings:
- **SM-F2, P2, fixed.** `write(t, state)` stamped any state on a ticket object captured earlier. In the command handler
  `t` is captured before `await prepare()`; if the operator typed meanwhile, the `input` hook had already written
  `cancelled`, and a later `prepare` rejection then wrote `failed` over it (and notified a checkpoint failure for a ticket the
  operator had ended). The newest entry decides on reload and for the 60-second "recently requested" guard, so a cancelled
  ticket changed identity. All writes now go through `MOVES`, a table in which `completed`, `cancelled` and `failed` are
  terminal; the current state is taken from the latest known ticket with that id, and a refused move does nothing (no entry, no
  notice). Tests: `a checkpoint that fails after the operator typed leaves the ticket cancelled, never failed` (fails
  without the fix) and `a failing checkpoint still records the failure when nothing else moved the ticket`.

## 12. Slack bridge poll — `src/slack-bridge.ts:70` (`SlackBridge`), `start` :95, `poll` :111

State: `timer`, `polling` (re-entrancy guard), `offUntil` (back-off timestamp), the cursor in `slack-cursor.json` (validated by
`cursor()`), plus the new `pollFailure`. A pass reads the inbox after the cursor, hands each DM to Pi as a steered user
message and moves the cursor past it.
Findings:
- **SM-F3, P2, fixed.** The poll ran whenever `slackOwner()` was defined, and `slackOwner` allowed a *paused import*
  (`importing` false, journal on disk). Pi's `input` hook (`src/index.ts:660`) answers every input with "import in progress"
  and `{action: 'handled'}` while `importing || pendingImport()`, extension input included, so a DM was handed over, dropped,
  and the cursor moved past it: the operator's message was lost until they asked again. The bridge now has an `accepting`
  gate, checked before the inbox is even requested, and `index.ts` passes `inPhase('open')` (see §15). Test: `a DM stays in the
  inbox while the chat cannot take it, and arrives once it can`.
- **SM-F5, P2, fixed.** `setInterval(() => void this.poll())` dropped the promise; `poll` can reject (`atomicWrite` of the
  cursor, `sendUserMessage` throwing when Pi is closing). That is an `unhandledRejection` per interval. The pass now settles
  into `pollFailed`: the failure is warned once (a repeat of the same text is silent, a success resets it) and the next
  interval retries from the same cursor. Test: `a poll pass that throws is retried and said once…` (without the fix the
  runner reports the rejection).
- P3 (catalogued). The back-off is flat: 30 s for an unreachable service, 5 min for a 404. Fine for a loopback service.

## 13. Slack bridge run facets — `src/slack-bridge.ts:72-79`

`running` (a run is in progress, so a DM is marked as arriving mid-run), `answering` (the run owes the DM an answer),
`waking` (a wake started the run). `stop`, `runEnded` clear all three. They are independent facets: a wake that a DM steers is
`running + answering + waking` and answers the DM; a plain run with no DM is `running` only. `answering` set while not
`running` is representable but not reachable (Pi emits `agent_start` before the user message events).
Findings:
- P3 (catalogued). `threads` (text → origin) is never cleared by `stop()`; a message that Pi never delivers leaves a small
  entry until the bridge is dropped. Bounded by one poll batch.
- Not refactored: collapsing the three flags into one union would have to represent all four reachable combinations and
  would add a type without removing an illegal state.

## 14. Slack approval posts — `src/slack-bridge.ts:20` (`askApproval`), `decided` :222, `settled`

State: `approvals` map (DM ts → request), one `schedule`d expiry per post, `settling` promise chain for the rewrites. A post
is deleted from the map before it is decided or rewritten, so a second decision or an expiry after a decision finds nothing.
Findings:
- P3 (catalogued). The expiry timer is never cancelled when the post is decided; it fires, finds nothing and returns. It is
  `unref`'d.

## 15. Profile availability — `src/index.ts:222` (`inPhase`), `src/profile-phase.ts`

Before: six independent facts (`active`, `remote`, `joined`, `stopping`, `importing`, `pendingImport(dir)` on disk) and seven
hand-written conjunctions of them in `index.ts` for the assistant service, assistant memory, Slack, the work tracker, catch-up,
commitments, corrections, plus an eighth for the connected-window server. They disagreed (Slack and the work tracker ignored a
paused import; catch-up, commitments and corrections ignored `stopping`).
After: `profilePhase()` derives one phase, first fact wins: `none` → `remote` → `importing` → `closing` → `import-paused` →
`open`; each feature names the phases it works in (`inPhase('open')`, `inPhase('open', 'import-paused')`, …), and the journal on
disk is read only when nothing earlier decided. A journal that cannot be parsed counts as paused instead of throwing into a
poll or a tool. Behaviour is unchanged except: Slack inbound waits for `open` (SM-F3), and catch-up, which already ignored
`stopping`, is now also allowed in `closing` with a paused import (read-only reports).
Test: `test/profile-phase.test.ts` (derivation order and lazy journal read).

## 16. Main run — `src/index.ts:668` (`startRun`), `agent_settled` :844

`working`, `runStarted`, `run`, `logged`, `keep`, `view`, `focusView`, `fault`, `reports`. `before_agent_start` /
`agent_start` open the run, `agent_settled` closes it; `stop()` resets every field in its `finally`. `fault` is sticky until
the next `openProfile` (it blocks `context_with_system` and the self-reload gate on purpose).
Findings:
- P3 (catalogued). `working` and `runStarted` describe one lifecycle in two booleans; Pi guarantees `before_agent_start`
  before `agent_start` before `agent_settled`, and a report turn started while idle goes through `agent_start` only
  (`startRun` is called from both). No reachable combination is wrong.

## 17. Sync lanes — `src/sync.ts:137` (`Lane`), `:149` (`Sync`)

`Lane.running` (one drain at a time) and `retryAfter` (timestamp). `Sync.closed`, one debounce `timer`. A failure sets
`retryAfter` and arms a timer that calls `schedule()`; `close()` stops new work, writes the status, and waits (bounded) for the
drains. Cursor files (`optmem-sync.json`, `ai-memory-sync.json`) are validated before use.
Findings: none. The retry timer fires `schedule()` (debounced) rather than `drain()`, so a timer that wakes a few ms before
`retryAfter` is absorbed by the debounce.

## 18. Operation journal — `src/operations.ts:41` (`OperationJournal`)

`started` → `response_recorded` (error flag makes it "uncertain") → `reconciled` (needs evidence). Persisted, size-bounded and
validated in the constructor (unknown keys, ids, fingerprints, status vs evidence); `inFlight` is the memory-only set of calls
still executing. `start` refuses a duplicate id and a full journal; `finish` ignores anything not `started`; `resolve`
refuses an in-flight call.
Findings: none. Explicit, validated, no bypassing writer.

## 19. Effect approvals — `src/authorization.ts:215` (`EffectApprovals`), `src/authorization-hooks.ts:148`

A pending call is `{approved: boolean, expires}` in a map keyed by token; `drop(token, outcome)` is the single exit and reports
`approved` / `denied` / `superseded` / `expired` once, only for calls that were still waiting. `admit` consumes an approved
entry on the next identical call. `expire()` runs on every entry point, approved entries included.
Findings:
- P3 (catalogued). In `advisedAdmission`, two concurrent identical calls both see the pending token without a note
  (`notes` is filled after the advisor answers), so the advisor is asked twice and the second answer is refused because the
  first already consumed the approval. It needs two identical gated calls in one parallel batch.

## 20. Subagent run — `src/runs.ts:36` (`moves`, `transition`), `src/agents.ts:124` (`Children`)

`running`, `waiting`, `paused`, `stopping`, `completed`, `failed`, `stopped`, `interrupted`, with `moves` as the transition
table and `transition(run, to)` the only writer of `state` (grep: no other assignment). A finished run only accepts the
outcome of a connected handoff; a repeat of the same state is a no-op that still answers true (so a second stop aborts a child
that ignored the first). `RunHistory` fails closed on load: invalid files are skipped with a warning, active runs found on disk
become `interrupted` (+ `cutOff` for resumable ones).
Findings: none. This is the model the rest of the package should look like; it was only catalogued.

## 21. Run guidance — `src/runs.ts:23`, `src/agents.ts:286,541,585,655`

`queued` → `delivered` | `undelivered`. Five writers (message_start match, interrupt hand-over, run end, failed `steer`,
`RunHistory` load). All of them start from `queued` except the failed-`steer` handler, which sets `undelivered` on a
message that may already be `delivered`.
Findings:
- P3 (catalogued). A `steer` that rejects after Pi already delivered the text marks it `undelivered`, and `tell` then throws
  "finished before it read the message". The user only sees an error for a message the agent did read.

## 22. `Children` counters — `src/agents.ts:131-139`

`closing` (profile shutting down), `launching` (slots reserved), `settling`, `resuming` and `deleting` (id sets), `launches` and
`completions` (promise sets that `close()` and `remove()` drain). Every `launching++` has a `finally` that gives the slot back;
`closing` is checked before and after each `await` in `launch` and `resume`; `remove` marks descendants repeatedly until no live
run is left. Findings: none.

## 23. pi-subagents RPC — `src/external-runs.ts:540` (`SubagentRpc.call`)

A promise with a `settled` flag, one reply channel per request id, one timeout; every exit (`reply`, `error`, `timeout`,
`emit` throw) goes through `cleanup` (unsubscribe + clear timer). Findings: none.

## 24. Connected-window connection — `src/window-bridge.ts:95` (`serveWindows` socket handler)

Per socket: `child`, `attached`, `ending`, `cursor`, `firstUser`, `lastStatus`, `finalMessages`, a serial `queue` of requests and
a 150 ms status timer. Phases: new → (attached | started) → ending → closed (`socket.once('close')` clears the timer, aborts
the controller, waits for the queue and ends the child). Requests are serialized, so `attach`/`start` cannot interleave.
Findings:
- P3 (catalogued). Five fields encode a four-phase connection. `start` sets `child` after `await children.spawn`; a socket
  that closes during the spawn is handled in the same branch (`finish(child, …)`), and the close handler's own
  `finish` is idempotent, so no double end is reachable.

## 25. Connected-window client — `src/connected-window.ts:81` (`openConnectedWindow`), `LiveTurn` :47

`started`, `ended`, `liveTurn`, `live`, `turn`: events from the owner drive `started` → status updates → `finished` (`ended`);
`submit` is refused after `ended`. `LiveTurn.dispose` clears its interval. Findings: none.

## 26. Import — `src/import/job.ts` (`pendingImport` :31, `prepareImport`, `runImport` :98, `discardImport`)

The state is the pair (`imports/pending.json`, `active-memory.json`): *prepared* (journal + staged generation, pointer on the
old one) → *running* (`Memory.open` on the new generation, resumed from its length) → *activated* (pointer swapped) →
*finished* (journal and staging removed). Crash points are ordered so each leaves a recoverable pair: the journal is removed
first on discard; the pointer is swapped last and `runImport` finishes the cleanup if it finds the pointer already moved.
The journal is validated field by field and refuses on any mismatch.
Findings: none.

## 27. Profile lock and lease — `src/profiles.ts:165` (`lockProfile`), `:195` (`holdProfile`)

Local: a socket whose lifetime is the lock (stale sockets are removed only if nothing answers and the inode is unchanged).
Store lease: `lease()` once, then `heartbeat()` every 10 s; a failed heartbeat only warns and the store is responsible for
fencing. Findings:
- P3 (catalogued). Heartbeats are not serialized: a heartbeat slower than 10 s overlaps the next. The `Store.lock` contract
  already puts fencing in the store.

## 28. Work tracker — `src/work-tracker.ts:52` (`WorkTracker`)

Per run: `started`, `run`, `waiting` (last run that ended with a question); per task (`Open`): `revision` and `status`
mirrored from the assistant service, advanced by `move` with an optimistic revision. Updates are serialized on `chain`; `off`
(no assistant) and `warned` make failures quiet.
Findings:
- P3 (catalogued). `Open.status` is a `string`, not the `Status` union the service takes; a `move` that fails on a revision
  conflict leaves the local revision stale and every later move for that task fails, with one warning for the session.

## 29. PR watch, morning summary, scoreboard — `src/slack-reports.ts:79,163,219`

Per day: `slack-daily.json` holds the day already claimed; the claim is written *before* posting (a crash must not post twice).
PR watch keeps `slack-prs.json` (`sig`, `seen`), with cleanup after `PR_KEEP_MS`. Three intervals, cleared on shutdown.
Findings:
- P3 (catalogued). At-most-once by design: a post that fails after the claim is not retried that day. A warning is logged
  once per session.

## 30. Production health round — `src/prod-health.ts:187` (`registerProdHealth`)

`busy` guards re-entry; `roundAll` catches per monitor, so `busy = false` is reached. Findings:
- P3 (catalogued). `busy` is reset after the `await`, not in a `finally`; it relies on `roundAll` never throwing. `session_start`
  also arms a 60-second first round that `session_shutdown` does not clear (one extra round on a closed profile, which
  `owner()` then refuses).

## 31. Operational state grants — `src/operational-state.ts:247,318`

Append-only validated log (ids are content hashes, lineage checked, size bounded). A grant is *active* until superseded
(explicit or by a newer overlapping record of the same action) or expired (`until`). Everything is derived on read.
Findings: none.

## 32. Compactor retry and cache priming — `src/compactor.ts:129` (`createCompressor`), `:56` (`primeFirst`)

Bounded counters: `failures < retries.length` for transport retries, `attempts < 5` for unusable replies, `closedRetries`. The
priming map holds a timestamp (warm) or a promise (priming) per cache prefix; `warmed(ok)` is called exactly once per call
(`responded` or the `finally`).
Findings:
- P3 (catalogued). If `new CompactorTrace(...)` threw between `gate()` and the `try`, the priming promise would never be
  released and later calls with that prefix would wait for their own abort. The constructor only reads fields; not reachable.

## 33. Pending input journal — `src/inbox.ts:10` (`Inbox`)

`record` → `claim` (a message matched it) → `acknowledge` (logged to memory); `dropReturned` removes queued inputs Pi handed
back to the editor; `recover` flushes the rest into memory on close. File validated on open. Findings: none.

## 34. Catch-up windows — `src/catchup.ts:22` (`CatchupWindows`)

`catchup.json`: cursor + bounded spans, strictly validated (timestamps round-trip, span ids match their bounds). `live` fails
closed if the transcript is shorter than the cursor. Findings: none.

## 35. Heartbeat queue — `src/heartbeat-queue.ts`

A markdown checklist is the state (`[ ]`, `[x]`, `[!]`, or "blocked" text on an open item), parsed on every read; there is no
in-memory copy. Findings: none.

## 36. UI views with a disposed flag

`AgentView`, `Inspector`, `LiveTurn`, `TabTitle`, `BarNavigation`: one `ended` boolean, one interval, `dispose()` clears the
interval and unsubscribes; input handlers return when `ended`. Findings: none.

---

## 37. Assistant computer lifecycle — `assistant/src/computer/manager.ts` (`create`, `cleanup`, `adoptOrphanedCreates`)

States of a `computers` row: `transition` (create in flight) → `ready` ⇄ `paused` → `removing` → deleted. A `computer_lifecycle` reservation (token, target, phase `active`/`failed`) fences each transition.
- Incident 01/11: Docker Desktop was off at startup; `docker run` failed, the process exited and left the row in `transition` with an `active` reservation. Every later start refused with `computer_transition`, and the whole assistant (Slack included) stayed down.
- Now: the process remembers the tokens it holds. `cleanup()` first turns any `transition` row whose token belongs to no live holder into a failed removal, and the owner census removes any container that create may have started. A transition held by the live process is still refused.
- Recovery: a Docker failure at startup no longer stops the service (`openToolServiceIfDockerUp`, #53); the next start with Docker up clears the orphan by itself.

## What changed in code

| id | sev | machine | change | regression test |
|----|-----|---------|--------|-----------------|
| SM-F1 | P2 | Heartbeat | `fireOnce` wraps the round; failure is noted and the clock re-armed | `test/heartbeat.test.ts` |
| SM-F2 | P2 | Self-reload ticket | `MOVES` table in `write`; terminal states are final | `test/self-reload.test.ts` |
| SM-F3 | P2 | Profile availability / Slack bridge | `profilePhase` + `accepting` gate | `test/profile-phase.test.ts`, `test/slack-bridge.test.ts` |
| SM-F4 | P2 | Commitment item | validate items on read | `test/commitments.test.ts` |
| SM-F5 | P2 | Slack poll | settle the poll promise, warn once, retry | `test/slack-bridge.test.ts` |
| SM-F6 | P1 | Assistant computer lifecycle | orphaned `transition` adopted as failed removal in `cleanup` | `assistant/test/computer-cleanup.test.ts` |
| SM-F7 | P1 | Slack bridge run facets | answer delivered before a steering notice (#58) | `test/slack-bridge.test.ts` |
