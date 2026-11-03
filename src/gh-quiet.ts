/**
 * `gh` forks a detached `gh send-telemetry` child after commands, and on Windows
 * that child opens a console window that flashes on screen (observed 03/11 16:46:40
 * in the process-start log: gh send-telemetry + OpenConsole in the same ms).
 * Every `gh` the harness or the agent's bash tool runs inherits this process's
 * environment, so turning telemetry off here covers them all. An explicit value
 * set by the operator wins.
 */
export function quietGhTelemetry(env: NodeJS.ProcessEnv = process.env): void {
  if (env.GH_TELEMETRY === undefined && env.DO_NOT_TRACK === undefined) env.GH_TELEMETRY = '0';
}
