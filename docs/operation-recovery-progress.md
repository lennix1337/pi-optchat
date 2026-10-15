# Uncertain operation recovery

## Implemented
- `operations.json` atomically records effectful tool intent before `tool_call` allows execution. Tool IDs are namespaced by session, arguments hashed, raw arguments/results excluded.
- Recorded response is explicitly `not_verified`, never external success. Missing response after reopen remains `started` (uncertain), blocks effectful tools, and permits a small exact-name read-only set plus recovery inspection.
- `operation_state` reconciliation requires an independent-observation evidence reference. This records an assertion, not proof or fresh authorization.
- Main and child sessions share one journal. In-flight tracking is process-only; after restart no intent is assumed still active. Settling one session must not invalidate another session's in-flight operations.
- Unknown tools and shell/codemode wrappers are conservatively effectful. Existing transcripts remain the source of original arguments and responses.

## Evidence
- Pre-implementation operations tests failed because module was absent.
- Initial three journal tests passed: missing-response reopen blocks replay, explicit evidence resolves, response is not verified success, IDs scoped, malformed data fails closed, read tools create no intent, raw arguments not stored.
- Review found response-write failure left an operation falsely in-flight: fixed with `finally` cleanup; actual filesystem write-failure regression confirms other sessions block before the failed session settles.
- Full suite initially had 374 pass/1 fail/1 skip: deterministic report-message failure exposed legal reuse of provider `spawn-1` across new assistant turns. Fixed hook identities using current session entry ID plus provider call ID, retaining result-to-intent mapping. Report/operation/provenance focused run now passes 11/11.
- Authorization/constraint provenance now requires the full exact direct-user source, preventing fabricated permission text attached to an unrelated valid user ID. Dedicated invocation test passes.
- Real Pi runtime integration tests and final checks remain pending.

## Limits
- Not distributed exactly-once execution; remote systems require their own idempotency keys.
- Read-only classification uses exact built-in names plus installed definitions annotated `readOnlyHint: true`. These author-provided hints rely on trusted definitions, not a security sandbox. Unknown verification tools need deliberate reconciliation/readback, not a shell regex claiming safety.
- A durable tool error response stays uncertain and blocks effects, because an error does not prove that no side effect occurred. Model must verify external state before retrying an errored mutation.
- The recovery guard covers extension-mediated tools, not user manual terminal commands or a malicious tool bypassing Pi events.
- Journal preserves all unresolved operations; it bounds history to 1,000 records and compacts only returned/reconciled records when full. Original transcript is preserved independently.

## Parent final offline integration evidence

Real Pi interruption/reopen/reconciliation/correlation fixture passes. Read-only installed metadata is used only from registered definitions (never model arguments); an unannotated destructive tool remains blocked even when arguments claim readOnlyHint. Exact-source operational updates/inspection appear in the next model context. New intentional calls may reuse provider call IDs across new assistant entries without collision. Full OptChat suite: 383 pass, one platform skip; typecheck and Pi compatibility 2/2 pass. These results do not prove live external exactly-once execution or fix the unknown native crash.
