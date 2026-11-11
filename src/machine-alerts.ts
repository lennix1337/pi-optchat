/** One owner's share of a sample: `cpuPct` is of the whole machine (all threads), so 100 means every thread busy. */
export interface GroupFrame { group: string; kind: string; detail?: string; cpuPct: number; rssMb: number; procs: number }
/** One sample reduced to what the alerts need. */
export interface Frame { t: number; threads: number; cpu: number | null; memPct: number; idleS: number | null; groups: GroupFrame[] }

export const CPU_ON = 90, CPU_OFF = 80, CPU_SUSTAIN_MS = 60_000;
export const MEM_ON = 85, MEM_OFF = 80, MEM_SUSTAIN_MS = 30_000;
export const OWNER_ON = 50, OWNER_OFF = 35, OWNER_SUSTAIN_MS = 120_000;
export const CLEAR_MS = 30_000, DEDUPE_MS = 15 * 60_000;
/** The least CPU share of one owner that the alert text names, and that counts toward "for N min". */
const NAMED_PCT = 3, DURATION_PCT = 10;

type Phase = { name: 'idle' } | { name: 'rising'; since: number } | { name: 'firing'; since: number; sent: boolean; peak: number; below?: number; culprit: string };
interface Condition { key: string; on: number; off: number; sustainMs: number; value: number | null; describe(frame: Frame, value: number, since: number): { text: string; culprit: string } }

const minutes = (ms: number) => ms < 90_000 ? `${Math.max(1, Math.round(ms / 1000))} s` : `${Math.round(ms / 60_000)} min`;

/**
 * Turns frames into messages: a condition must hold for its sustain time before it speaks, speaks once per culprit per 15 minutes,
 * and says when it is over (but only if it spoke). It sees time only through the frames, so a test drives it with a fake clock.
 */
/** Thresholds a test or a live check may scale down; the defaults above are what runs for real. */
export interface Limits { cpuOn: number; ownerOn: number; sustainMs: number }

export class MachineAlerts {
  constructor(private limits: Partial<Limits> = {}) {}
  private phases = new Map<string, Phase>();
  private lastSent = new Map<string, number>();
  /** Since when each group has used at least DURATION_PCT of the machine, for the "for N min" in a message. */
  private heavySince = new Map<string, number>();
  /** Lines to append to the next alert that fires (what the governor did about it). */
  actionNote?: () => string | undefined;

  evaluate(frame: Frame): string[] {
    this.trackHeavy(frame);
    const conditions: Condition[] = [
      { key: 'cpu', on: this.limits.cpuOn ?? CPU_ON, off: (this.limits.cpuOn ?? CPU_ON) * CPU_OFF / CPU_ON, sustainMs: this.limits.sustainMs ?? CPU_SUSTAIN_MS, value: frame.cpu,
        describe: (f, value, since) => { const top = this.top(f); return { culprit: `cpu:${top[0]?.group ?? '?'}`, text: `CPU ${Math.round(value)}% for ${minutes(f.t - since)} on ${f.threads} threads. ${this.named(f, top)}` }; } },
      { key: 'memory', on: MEM_ON, off: MEM_OFF, sustainMs: Math.min(MEM_SUSTAIN_MS, this.limits.sustainMs ?? MEM_SUSTAIN_MS), value: frame.memPct,
        describe: (f, value, since) => { const top = [...f.groups].sort((a, b) => b.rssMb - a.rssMb); return { culprit: `mem:${top[0]?.group ?? '?'}`, text: `Memory ${Math.round(value)}% in use for ${minutes(f.t - since)}. Largest: ${top.slice(0, 3).map(g => `${this.name(g)} ${Math.round(g.rssMb)} MB (${g.procs} procs)`).join('; ')}.` }; } },
    ];
    for (const g of frame.groups) {
      if (g.kind === 'machine') continue;
      conditions.push({ key: `owner:${g.group}`, ...this.ownerLimits(), value: g.cpuPct,
        describe: (f, value, since) => ({ culprit: `cpu:${g.group}`, text: `${this.name(g)} alone uses ${Math.round(value)}% of the machine (${g.procs} procs) for ${minutes(f.t - since)}.` }) });
    }
    // A group that went quiet has no condition this frame: treat it as a value of zero so it can recover.
    for (const key of this.phases.keys()) if (key.startsWith('owner:') && !conditions.some(c => c.key === key)) conditions.push({ key, ...this.ownerLimits(), value: 0, describe: () => ({ text: '', culprit: key }) });
    const messages: string[] = [];
    for (const c of conditions) { const message = this.step(frame, c); if (message) messages.push(message); }
    for (const [key, phase] of this.phases) if (phase.name === 'idle') this.phases.delete(key);
    return messages;
  }

  private ownerLimits() { const on = this.limits.ownerOn ?? OWNER_ON; return { on, off: on * OWNER_OFF / OWNER_ON, sustainMs: this.limits.sustainMs ? this.limits.sustainMs * 2 : OWNER_SUSTAIN_MS }; }

  private step(frame: Frame, c: Condition): string | undefined {
    if (c.value === null) return undefined;
    const phase = this.phases.get(c.key) ?? { name: 'idle' } as Phase;
    if (phase.name === 'idle') { if (c.value >= c.on) this.phases.set(c.key, { name: 'rising', since: frame.t }); return undefined; }
    if (phase.name === 'rising') {
      if (c.value < c.on) { this.phases.delete(c.key); return undefined; }
      if (frame.t - phase.since < c.sustainMs) return undefined;
      const { text, culprit } = c.describe(frame, c.value, phase.since);
      const last = this.lastSent.get(culprit);
      const sent = last === undefined || frame.t - last >= DEDUPE_MS;
      this.phases.set(c.key, { name: 'firing', since: phase.since, sent, peak: c.value, culprit });
      if (!sent) return undefined;
      this.lastSent.set(culprit, frame.t);
      const action = this.actionNote?.();
      return `[machine] ${text}${action ? ` ${action}` : ''}`;
    }
    phase.peak = Math.max(phase.peak, c.value);
    if (c.value >= c.off) { phase.below = undefined; return undefined; }
    phase.below ??= frame.t;
    if (frame.t - phase.below < CLEAR_MS) return undefined;
    this.phases.delete(c.key);
    if (!phase.sent) return undefined;
    const what = c.key === 'cpu' ? 'CPU' : c.key === 'memory' ? 'Memory' : c.key.slice('owner:'.length);
    return `[machine] ${what} is back to normal (${Math.round(c.value)}%, peak ${Math.round(phase.peak)}%, ${minutes(frame.t - phase.since)} high).`;
  }

  private trackHeavy(frame: Frame) {
    const seen = new Set<string>();
    for (const g of frame.groups) if (g.cpuPct >= DURATION_PCT) { seen.add(g.group); if (!this.heavySince.has(g.group)) this.heavySince.set(g.group, frame.t); }
    for (const group of this.heavySince.keys()) if (!seen.has(group)) this.heavySince.delete(group);
  }
  private name(g: { group: string; detail?: string }) { return g.detail ? `${g.group} ${g.detail}` : g.group; }
  private top(frame: Frame) { return [...frame.groups].filter(g => g.kind !== 'machine').sort((a, b) => b.cpuPct - a.cpuPct); }
  private named(frame: Frame, top: GroupFrame[]) {
    const shown = top.filter(g => g.cpuPct >= NAMED_PCT).slice(0, 3);
    if (!shown.length) return 'No single owner stands out.';
    const parts = shown.map(g => {
      const since = this.heavySince.get(g.group);
      return `${this.name(g)}: ${g.procs} procs, ${Math.round(g.cpuPct)}% CPU${since !== undefined && frame.t - since >= 60_000 ? `, ${minutes(frame.t - since)}` : ''}${g.kind === 'external' ? ' (not ours)' : g.kind === 'unattributed' ? ' (owner unknown)' : ''}`;
    });
    return `Top: ${parts.join('; ')}.`;
  }
}
