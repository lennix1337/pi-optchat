export interface ProdContainer { name: string; status: string; recent: boolean; image: string; short: string; tag: string; state: string; health: string; exitCode?: number }
export interface ProdFacts {
  complete: boolean; load?: (number | undefined)[]; uptimeSec?: number; memTotalKb?: number; memAvailKb?: number;
  disks: { mount: string; pct: number }[]; containers: ProdContainer[]; stats: { name: string; cpu?: number; mem: string }[];
  nginx?: { total: number; c2: number; c3: number; c4: number; c5: number }; tls: Record<string, number>;
  ttfb: { ms: number; code: number }[]; probes?: { key: string; up: boolean; ms?: number }[]; skipped: string[]; promFailed: boolean;
}
export interface ProdLimits { sinceMin?: number; disk?: number; memAvailPct?: number; err5xxMin?: number; err5xxShare?: number; ttfbSlowMs?: number; probeSlowMs?: number; sshTimeoutMs?: number }
export interface ProdResult { host: string; elapsedMs: number; status: 'healthy' | 'problems' | 'unreachable'; sinceMin?: number; facts?: ProdFacts; problems?: string[]; error?: string; hint?: string }
export interface SshRun { code: number; stdout: string; stderr: string }
export const DEFAULTS: Required<ProdLimits>;
export const DEFAULT_HOST: string;
export const KNOWN_HOSTS: string[];
export function buildRemoteScript(sinceMin: number): string;
export function sshArgs(alias: string): string[];
export function parseRemote(text: string): ProdFacts;
export function judge(facts: ProdFacts, limits?: ProdLimits): string[];
export function classifySshFailure(stderr: string, code: number): { error: string; hint: string };
export function checkHost(alias: string, opts?: { sinceMin?: number; limits?: ProdLimits; sshTimeoutMs?: number }, run?: (alias: string, script: string, timeoutMs: number) => Promise<SshRun>, now?: () => number): Promise<ProdResult>;
export function exitCode(results: readonly ProdResult[]): number;
export function renderHost(result: ProdResult): string[];
export function render(results: readonly ProdResult[]): string;
export function parseArgs(argv: readonly string[]): { hosts: string[]; sinceMin: number; json: boolean; error?: string };
export function main(argv: readonly string[], run?: (alias: string, script: string, timeoutMs: number) => Promise<SshRun>): Promise<number>;
