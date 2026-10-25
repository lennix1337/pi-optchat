---
name: effect-approvals
description: Use for OptChat effect-approval refusals, exact-invocation authorization tokens, untrusted approval input, or validating the opt-in mechanical tool gate.
---

# Effect approvals

Read `../../docs/effect-approvals.md` for activation, limits and checks.

- The gate is opt-in (`OPTCHAT_EFFECT_APPROVALS=1` gates every effect; `=risk` only push, publish, global install, recursive delete outside temp, discard and paid calls; classes in `docs/effect-approvals.md`), not active merely because its code exists. Do not enable it or reload the active chat without operator authority.
- A cheap advisor model sees each blocked call first and runs it when it approves; you only see a refusal when it denied, failed or is off. Its refusal is not the operator's: do not retry the same call to fish for another verdict, and do not reword a call to slip past it.
- A blocked invocation did not run; the operator sees it on screen. Say in one line what it does and wait: the operator types `/approve` (newest pending call, once) or `/deny`, or `approve-effect <pending-token>` alone. Each grants one identical invocation in that session and working directory. Never generate the approval as a tool, hidden event, RPC input or quotation. After `Denied by the operator`, do not retry the call.
- Permission is consumed on the attempt, not replenished by failure. Nested calls, changed arguments and replay need separate approval; uncertain effects still require independent reconciliation.
- Do not claim an OS sandbox, direct-provider-call interception or imported standing grants. Local edits and opaque execution also need tokens in this conservative mode; read-only diagnostics remain available.
- Validate with `project_checks` names `effect-approvals` and `effect-approval-runtime`. The latter uses the installed SDK with a scripted provider and rejected network, not the active interactive profile.
