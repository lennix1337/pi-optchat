# Uncertain operation recovery

## 2026-10-22 harness retrospective

The diagnostic grammar now admits bounded `cmp`, `diff`, `od`, `file`, `stat`,
`sort`, `uniq`, `cut`, piped `tr`, `nl`, `which`, `type`, `tasklist` and selected
Git inspections. Writes, helpers requested through flags, file redirection,
expansions and process substitution fail closed. In particular `uniq -- -f out`
is a two-operand write, not an option followed by a read. Configured Git helpers
remain a trusted-environment limitation, not a sandbox guarantee.

Known pre-dispatch `project_checks` timeout-validation and active-check refusals
no longer create uncertainty just because their text contains those words.
Generic error prefixes are not accepted as no-effect evidence; HTTP gateway
failures, actual timeouts, signals and transport failures still block effects.
Terminal native check receipts use their explicit execution status and exit code,
not words such as "interrupted" in failed assertions. Timeout/cancelled/nonterminal
receipts remain uncertain; a completed failed check is not a passing check.
Existing uncertain operations are never automatically reconciled.

Bash results can receive one short native-tool hint for scripted source edits,
single-file reads or supported Ripwire CLI flags. Each hint is limited to once
per ten Bash results per session. Original result metadata and terminal exit-code
markers are retained; both parent and child sessions register safety first.

Validation recipes: `project_checks` lists `operation-safety`, `typecheck` and
`unit` from `.pi/checks.json` (plus isolated `pi-compat` lifecycle fixtures).
Parent integration passed 31 focused tests, TypeScript, and the full suite
(632 passed, 1 skipped); Pi 1.2 lifecycle fixtures passed 2/2. Two parent-review
regressions failed before the fixes: output operands after `uniq --`, and generic
refusal prefixes hiding HTTP 502 or uncertain post-dispatch failures.

Summary optimization was measured separately and rejected: pairing reduced
bytes but lost facts; the delta/merge-once prompt also failed its recall gate.
Production compactor sources remain at `f860bc17`. The explicit, paid
`benchmark:summaries` entry point is not part of these offline recipes. Raw
results and variant backups remain under ignored `scratchpad/benchmarks/` in the
retro-compactor worktree. Small samples and imperfect recall metrics do not
establish universal fidelity, latency, cost or cache effects.

Live activation still requires a deliberate `/reload` or new Pi session. No
live reload or Git publication is part of this validation.


## Implemented
- `operations.json` atomically records effectful tool intent before `tool_call` allows execution. Tool IDs are namespaced by session, arguments hashed, raw arguments/results excluded.
- Recorded response is explicitly `not_verified`, never external success. Missing response after reopen remains `started` (uncertain), blocks effectful tools, and permits a small exact-name read-only set plus recovery inspection.
- `operation_state` reconciliation requires an independent-observation evidence reference. This records an assertion, not proof or fresh authorization.
- Main and child sessions share one journal. In-flight tracking is process-only; after restart no intent is assumed still active. Settling one session must not invalidate another session's in-flight operations.
- Unknown tools and shell/codemode wrappers are conservatively effectful except for the bounded Bash diagnostic grammar described below. Existing transcripts remain the source of original arguments and responses.

## Evidence
- Pre-implementation operations tests failed because module was absent.
- Initial three journal tests passed: missing-response reopen blocks replay, explicit evidence resolves, response is not verified success, IDs scoped, malformed data fails closed, read tools create no intent, raw arguments not stored.
- Review found response-write failure left an operation falsely in-flight: fixed with `finally` cleanup; actual filesystem write-failure regression confirms other sessions block before the failed session settles.
- Full suite initially had 374 pass/1 fail/1 skip: deterministic report-message failure exposed legal reuse of provider `spawn-1` across new assistant turns. Fixed hook identities using current session entry ID plus provider call ID, retaining result-to-intent mapping. Report/operation/provenance focused run now passes 11/11.
- Authorization/constraint provenance now requires the full exact direct-user source, preventing fabricated permission text attached to an unrelated valid user ID. Dedicated invocation test passes.
- Real Pi runtime integration tests and final checks remain pending.

## Limits
- Not distributed exactly-once execution; remote systems require their own idempotency keys.
- Read-only classification uses exact built-in names plus installed definitions annotated `readOnlyHint: true`. These author-provided hints rely on trusted definitions, not a security sandbox. Unknown verification tools need deliberate reconciliation/readback. A bounded Bash diagnostic grammar now recognizes only trusted `pwd`, `ls`, `cat`, `head`, `tail`, `wc`, and `grep` invocations with simple quoting and separators; unsupported syntax fails closed. This is not general shell analysis or a sandbox.
- A durable tool error response stays uncertain and blocks effects, because an error does not prove that no side effect occurred. Model must verify external state before retrying an errored mutation.
- The recovery guard covers extension-mediated tools, not user manual terminal commands or a malicious tool bypassing Pi events.
- Journal preserves all unresolved operations; it bounds history to 1,000 records and compacts only returned/reconciled records when full. Original transcript is preserved independently.

## Parent final offline integration evidence

Real Pi interruption/reopen/reconciliation/correlation fixture passes. Read-only installed metadata is used only from registered definitions (never model arguments); an unannotated destructive tool remains blocked even when arguments claim readOnlyHint. Exact-source operational updates/inspection appear in the next model context. New intentional calls may reuse provider call IDs across new assistant entries without collision. Full OptChat suite: 383 pass, one platform skip; typecheck and Pi compatibility 2/2 pass. These results do not prove live external exactly-once execution or fix the unknown native crash.

## Diagnostic-error false positives

Reproduced the report before the fix: a completed read-only Bash diagnostic with
`isError=true` blocked the next action. Two new regressions failed first. The
bounded diagnostic classifier now bypasses effect journaling both in direct
journal starts and in registered Pi tool-call hooks. An existing uncertain
mutation remains pending even when subsequent diagnostics run; no old records
are automatically cleared. Git, ripwire, Code Mode and unsupported shell syntax
remain effectful rather than assuming every nonzero exit is harmless.

Verified offline: TypeScript; 10 focused diagnostic/journal tests; full suite
404 passed, 1 skipped; Pi 1.2 compatibility 2/2. Ripwire edit-check and
quality-delta passed (no gating regression); test-gate still reports 18 impacted
symbols without mapped coverage and exits 4. Live activation requires `/reload`;
interactive behavior after reload is not verified. No paid inference or Git
publication was performed for this change.

## 2026-10-16 reliability/performance pass

Intent and response receipts now include wall-clock timestamps and an optional `dispatchObserved` marker. Pi 1.2 emits dispatch before validation/tool_call, so this marker is persisted with the intent without another disk write; it proves neither body execution nor absence of effects. Reopen tests preserve the interruption barrier, and an actual headless Pi write/independent readback verifies lifecycle correlation. Existing error/persistence/replay rules are unchanged.

Final offline validation: typecheck; full suite478 passed/1 skipped; Pi compatibility2/2; focused reliability entrypoint26/26 before the final added pre-response assertion (the assertion then passed in the final full suite). Recurring live harness uncertainty is not attributed or fixed by these diagnostics. Native metadata identifies a stack-cookie fast fail, not its corrupting component. See [five-area results and remaining limits](reliability-performance.md), with raw evidence under ignored `scratchpad/reliability-performance`. Existing session needs `/reload`; no account switching, paid inference or Git publication.
