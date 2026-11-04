/**
 * Pi's bash tool starts commands with stdin on the null device. On Windows, Python 3.13+
 * then treats `NUL` as a terminal: a `python -` whose heredoc never arrived opens the new
 * REPL, whose console read fails, and it prints that traceback forever at one full core.
 * Four such orphans ran for a day and a half (observed 03/11: `python.exe -` in
 * `_pyrepl` showtraceback, OSError 22/WinError 123, ~3.4 MB/s of output each).
 * The basic REPL reads EOF from `NUL` and exits at once, so every Python the harness
 * or the agent's bash starts inherits it. An explicit value set by the operator wins.
 */
export function basicPythonRepl(env: NodeJS.ProcessEnv = process.env): void {
  if (env.PYTHON_BASIC_REPL === undefined) env.PYTHON_BASIC_REPL = '1';
}
