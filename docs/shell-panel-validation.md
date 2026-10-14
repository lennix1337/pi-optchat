# Shell panel — implementation and evidence

Base: OptChat 0.8.4, `90d6ab7`, matching the installed Git package. Worktree: `worktrees/shell-panel`, branch `lennix/shell-panel`. No source commit/push requested.

## Contract

- Integrate with the existing below-editor bar and F6 inspector, not a competing footer.
- Model-invoked Bash/PowerShell calls are observed, including child sessions and nested calls when Pi emits events. Ordinary foreground execution is unchanged.
- Explicit `shell_start` jobs use native local Bash execution, return immediately and have their own abort controller. `shell_status` reads state/output without waiting. `shell_stop` cancels one managed job.
- UI: command/state/mode/duration, Enter output, scrolling/End, Escape back, K then Enter to stop, Escape cancels confirmation. Stop confirmation binds to the original ID, not a moving row.
- Keep active counts visible at 30/40/80/120 columns. Retain at most 50 finished executions and 32,000 characters of output per job. No disk transcript for the panel.
- Stop managed processes on profile close/reload. Never claim to manage external processes, manual `!`/`!!` commands or detached children.

## Verified

- `npm run check` passed on the current base.
- Final full suite: 335 passed, 1 skipped; focused suite (including footer-width regression): 18/18 passed. Final type-check and actual Pi 1.2 loader probe also passed.
- Native shell regression observed a real child PID and output, then confirmed process termination after cancellation.
- Actual installed Pi 1.2 extension loader: no errors; all three managed-shell tools registered.
- Separate Pi 1.2 native probe: output streaming, cancellation/child termination and nonzero-exit error result passed. No model inference.
- UI component tests: output control sequences cannot clear the terminal; list/detail navigation, confirmation/cancel, resize and footer counts passed.
- `git diff HEAD --check` passed. Impeccable detector reported no findings for the changed TUI files.

## Not verified / limits

- The current interactive Pi has not reloaded the extension; final live keyboard/visual validation remains pending.
- Ripwire edit-check reports no baseline for the new function; quality-delta could not find its baseline. Test-gate emits conservative, unresolved call-graph coverage; the full suite was run instead.
- Abrupt OS termination does not execute extension cleanup; native process lifecycle behavior is Pi's responsibility.
