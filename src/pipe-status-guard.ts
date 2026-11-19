/**
 * `cmd | tail; echo rc=$?` reports the exit code of tail, not of cmd, so a failed build or test reads as rc=0
 * (operator 13/11, three runs reported tail's rc=0). The call is refused before it runs, with the exact rewrite.
 */
const PIPE_THEN_RC = /\|\s*(?:tail|head|grep)\b(?:[^;\n|&]|&(?!&))*(?:;|&&)\s*(?:echo|printf)\s+["']?rc=\$\?/u;

export function pipeStatusRefusal(command: string): string | undefined {
  if (!PIPE_THEN_RC.test(command)) return undefined;
  return 'Não executado: `… | tail/head/grep; echo rc=$?` imprime o código do tail, não o do comando. Troque `rc=$?` por `rc=${PIPESTATUS[0]}` e rode de novo.';
}
