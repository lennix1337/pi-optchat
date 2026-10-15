# Privacy-safe incident diagnostics and usage attribution

## Scope and current status

Implemented in `src/usage.ts`, `src/compactor-diagnostics.ts`, `src/diagnostic-metadata.ts`, and `src/inspector.ts`, with regressions in the matching usage, diagnostics, and inspector tests.

- Existing `usage.jsonl` records remain readable with their legacy role/model/provider/session fields; attribution fields are optional. New writes project usage onto known numeric fields and allowlisted metadata, dropping arbitrary strings and extra properties.
- Usage records can carry a compaction-local `incidentId`, a separate main recovery `recoveryIncidentId`, `attempt`, `kind`, `outcome`, `failed`, and a bounded `errorCategory`. Backfill labels main conversation vs. subagent and marks explicit assistant error/abort outcomes. Compaction records mark unusable/zero-text, tool-call, truncation, error, and aborted replies as failed when evidence exists.
- Usage summaries and the Usage inspector attribute failure counts by role/provider/model. They report usage/cost only; they do **not** infer provider quota consumption. Failures without provider-reported usage stay diagnostics-only instead of receiving fabricated zero usage.
- Compactor diagnostics are projected onto a metadata-only schema before persistence. Prompt/output/reasoning/tool arguments, arbitrary exception strings, authorization headers, and unrecognized properties are excluded. Usage is copied from known numeric fields. Identifier-shaped metadata and diagnostic categories are filtered; diagnostics rotate at the existing 1 MB bound.
- `createCompactorIncidentId()` is exported from `src/compactor-diagnostics.ts`; `UsageAttribution` is exported from `src/usage.ts`. `RecoveryIncidentEvent`, `RecoveryPhase`, `RecoveryCategory`, `sanitizeRecoveryDiagnostic()`, and `writeRecoveryDiagnostic()` are also exported there. The PMA event schema is exact: phases `started|recovering|stopped|completed`; categories `policy_refusal|quota|context_limit|transient|unknown`. `sessionId` is optional and sanitized as an identifier. Recovery events are persisted to bounded `recovery-diagnostics.jsonl` after strict enum projection.

## Parent integration status

The shared worktree now has parent-owned wiring in `src/index.ts`, `src/compactor.ts`, `src/agents.ts`, and `src/operations.ts`: it subscribes to `optchat:recovery`, persists sanitized events, captures `{sessionId, recoveryIncidentId}` before a compaction request/retry loop, passes the snapshot to per-attempt diagnostics/usage attribution, and associates operation-journal calls with the root ID. The compactor-local `incidentId` remains distinct and correlates attempts within one compaction.

The PMA event contract is `RecoveryIncidentEvent` with `incidentId`, `phase`, `category`, optional `provider`, `model`, `sessionId`; phase is `started|recovering|stopped|completed` and category is `policy_refusal|quota|context_limit|transient|unknown`. `writeRecoveryDiagnostic(directory, event)` stores only those fields after strict enum and metadata projection, plus a local timestamp. Raw errors/prompts are not part of the event or persisted schema.

Correlation is **not yet end-to-end verified**: Ripwire's literal scan found event subscribers but no `optchat:recovery` emitter in this worktree at the time of the check. The PMA-side emission and a real event → recovery JSONL → compaction diagnostic/usage → tool-journal correlation flow remain parent-owned. Once emitted, no provider quota claim follows from these correlations; API-reported usage and local cost estimates remain separate from provider quota. Conversation and child-session attribution comes from Pi backfill roles.

## Verification

- Focused command: `npx tsx --import ./test/support.ts --test test/usage.test.ts test/compactor-diagnostics.test.ts test/inspector.test.ts test/compactor-retry.test.ts` — **38 passed, 0 failed**, including per-invocation root-ID snapshot propagation.
- Coverage includes old ledger records, idempotent replay, main/subagent attribution, two zero-output failed attempts sharing one compaction ID and a separate recovery ID, recovery event enum allowlists/session correlation, strict rejection of non-enum categories/phases, policy-refusal classification, redaction of prompt/error/credential-shaped data, diagnostic schema projection, and visible model-level failure counts.
- Focused tests pass after the shared metadata-validator extraction and diagnostics writer consolidation.
- `npm run check` is pending parent call-site updates for the simplified `CompactorTrace` constructor and a type error in `test/recovery-runtime.test.ts:133`; these are parent-owned files. Earlier, before that constructor simplification, TSC passed.
- Ripwire quality-delta still exits nonzero on cross-worktree changes (primarily parent-owned store/operations work); no new owned-scope duplication regressions remain. Test-gate identifies 26 usage-related tests and additional untested blast-radius symbols; the focused relevant suites were executed.
- The PMA event emitter and real event-bus end-to-end correlation are not yet verified. No paid calls, commit, push, or deployment were performed.

## Parent integration evidence (supersedes pending items above)

The real Pi synthetic-provider runtime fixture now verifies the event-bus → recovery JSONL → compactor diagnostics/usage → tool-journal flow. Eight post-event compactor snapshots carry the same root UUID and actual session ID; compaction-local attempt IDs remain distinct. Full OptChat tests pass 383/384 (one platform skip), typecheck passes, Pi 1.2 compatibility passes 2/2. PMA's actual registered-hook emitter/failover suite is being validated separately; paid/live provider recovery remains unverified. A `completed` recovery phase denotes control-flow settlement, not verified external success or a provider-quota assertion. Recovery logs are explicitly excluded from memory checkpoints, including when an old/custom `.gitignore` exists.
