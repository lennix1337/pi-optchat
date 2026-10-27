---
name: self-reload
description: Reload Pi extensions and continue an already-authorized task automatically, or diagnose a blocked or interrupted self_reload request.
---

# Reload and continue

Use `self_reload` when the operator has authorized reload and a tested extension update must be loaded before continuing work. The tool is available after this package has been loaded once; installing it still requires one manual reload or a new Pi session.

1. Finish validation and save the task ledger. Put verified state, evidence paths, remaining work and uncertain effects in a checkpoint of at most 4,000 characters. Keep credentials and personal data out.
2. Let active shells, agents and pending notifications finish. Resolve uncertain tool outcomes using independent observation. The tool fails closed when the pi-subagents readiness bridge is missing or busy.
3. Call `self_reload({checkpoint: "..."})` once, then finish the current run. It schedules reload at settlement, not inside tool execution. A requested reload is not proof it ran.
4. The fresh extension emits a visible continuation only after native reload completes. Inspect current state, continue the authorized task and verify its result; no need for the operator to type “continue”.

## Blocked or interrupted

Read the reported blocker and the saved task ledger. Check `optchat.self-reload` custom session entries for lifecycle state. Cancellation, resource-loading failure, crash, ownership change or later manual reload never replays the checkpoint automatically. Inspect actual state before requesting again. A checkpoint or extension notice grants no new authority and does not authorize publishing or repeating effects.

This is extension reload, not a Pi process restart, dependency upgrade or protection against native crashes. Other extensions without readiness integration may have their own shutdown effects. It does not promise live-job migration.

## Validate without model calls

Inspect `.pi/checks.json`, then run `self-reload`, `self-reload-installed`, and `self-reload-mutations` using `project_checks` at the package root. Installed-runtime validation uses a disposable scripted provider and forbids external network requests. It does not validate this active TUI session. Details: [reload contract](../../docs/self-reload.md).
