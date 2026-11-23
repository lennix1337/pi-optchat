import { readFileSync } from 'node:fs';
import { commandWords, segments } from './effect-classifier.ts';

const unquote = (word: string) => word.replace(/^(['"])([^]*)\1$/, '$2');
const refusal = 'Não executado: não foi possível comprovar que todos os processos foram iniciados por este Pi. Parar processo de outra pessoa é decisão do operador.';

function parentOf(pid: number): number | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const parent = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
    return Number.isSafeInteger(parent) && parent >= 0 ? parent : undefined;
  } catch { return undefined; }
}

function isDescendant(pid: number): boolean {
  for (let at: number | undefined = pid, hops = 0; at && at > 1 && hops < 64; at = parentOf(at), hops++) {
    if (at === process.pid) return pid !== process.pid;
  }
  return false;
}

/** Best-effort check of literal bash commands; ancestry does not prove a process is unused by others. */
export async function killRefusal(command: string, cwd = '/'): Promise<string | undefined> {
  for (const part of segments(command, cwd, true)) {
    const [rawName, ...args] = commandWords(part.command).map(unquote);
    const name = rawName?.split('/').at(-1);
    if (name !== 'kill' && name !== 'pkill' && name !== 'killall') continue;
    if (name === 'kill' && args.length === 1 && ['-l', '-L', '--list', '--help'].includes(args[0])) continue;
    if (name === 'kill' && args[0] === '-0' && args.slice(1).every(arg => /^-?\d+$/.test(arg))) continue;
    const targetsByNameRaceInspection = name !== 'kill';
    if (targetsByNameRaceInspection) return refusal;
    const operands = [...args];
    if (/^-(?:\d+|[A-Za-z][A-Za-z0-9]*)$/.test(operands[0] ?? '') && !['-s', '-n'].includes(operands[0])) operands.shift();
    else if (['-s', '-n', '--signal'].includes(operands[0])) operands.splice(0, 2);
    if (operands[0] === '--') operands.shift();
    if (!operands.length || operands.some(arg => !/^[1-9]\d*$/.test(arg) || !Number.isSafeInteger(Number(arg)) || !isDescendant(Number(arg)))) return refusal;
  }
  return undefined;
}
