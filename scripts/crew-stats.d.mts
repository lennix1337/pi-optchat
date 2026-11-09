export interface CrewStatsRow { role: string; model: string; calls: number; cost: number; tokensPerCall: number }
export interface CrewStats { opusMain: { calls: number; cost: number }; total: number; rows: CrewStatsRow[] }
export function crewStats(lines: readonly string[], sinceMs?: number, untilMs?: number): CrewStats;
