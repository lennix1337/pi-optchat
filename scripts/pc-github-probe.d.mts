export interface ProbeRow { group: 'github' | 'control'; host: string; ok: boolean }
export interface Verdict { code: 'ok' | 'github-partial' | 'github-unreachable' | 'pc-offline' | 'no-data'; exit: number; line: string }
export function parseProbe(out: string): ProbeRow[];
export function judge(rows: ProbeRow[]): Verdict;
