// external: A shell pipeline status is the status of its final command unless pipefail is set.
const PIPE_THEN_RC = /\|\s*(?:tail|head|grep)\b(?:[^;\n|&]|&(?!&))*(?:;|&&)\s*(?:echo|printf)\s+["']?rc=\$\?/u;

export function pipeStatusRefusal(command: string): string | undefined {
  if (!PIPE_THEN_RC.test(command)) return undefined;
  return 'Não executado: `… | tail/head/grep; echo rc=$?` imprime o código do tail, não o do comando. Troque `rc=$?` por `rc=${PIPESTATUS[0]}` e rode de novo.';
}
