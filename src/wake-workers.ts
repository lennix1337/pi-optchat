/** A native launch is owned only after its original assistant call and successful tool result agree.
 * Report transport is void in Pi: queued, observed and processed are deliberately separate. */
export const WORKER_WAIT_MS = 30 * 60_000;
export const WORKER_DELIVERY_MS = 60_000;
export const WORKER_RECOVERY = '[OptChat heartbeat] Worker continuation not verified within its deadline. Inspect the saved worker result and current state; do not repeat spawn or any other effect. Report exactly what remains unverified.';
export const WORKER_UNVERIFIED = 'Continuação do worker não verificada: o relatório não foi processado dentro do prazo. Nenhum efeito foi repetido automaticamente.';

interface Pending { deadline: number; limit: number; report?: string; observed?: boolean; reviewed?: boolean }
export class WakeWorkers {
  private calls = new Set<string>();
  private launches = new Map<string, string[]>();
  private owned = new Map<string, Pending>();
  private reports = new Map<string, { ids: string[]; observed: boolean; reviewed: boolean; limit: number; at: number }>();
  private recovery: Pending | undefined;
  /** Peers resumed (at `since`) by a run whose launch is not confirmed yet: owned once it is. */
  private adoptions = new Map<string, { run: string; since: number }[]>();
  notVerified = false;
  constructor(private readonly now: () => number = Date.now) {}
  called(id: string) { this.calls.add(id); }
  launched(id: string, ids: string[]) { if (this.calls.has(id)) this.launches.set(id, ids); }
  result(id: string, ids: unknown, error?: boolean) {
    const launched = this.launches.get(id);
    if (error || !launched || !Array.isArray(ids) || ids.length !== launched.length || ids.some((value, i) => value !== launched[i])) return;
    this.launches.delete(id);
    for (const run of launched) {
      this.own(run);
      for (const peer of this.adoptions.get(run) ?? []) this.own(peer.run, peer.since);
      this.adoptions.delete(run);
    }
  }
  /** `since`: when a finished run was resumed; a report it gave before that is not the one awaited now. */
  private own(run: string, since = -Infinity) {
    const report = [...this.reports].find(([, value]) => value.ids.includes(run) && value.at >= since);
    const limit = report?.[1].limit ?? this.now() + WORKER_WAIT_MS;
    this.owned.set(run, { deadline: report?.[1].observed ? Infinity : limit, limit,
      ...report ? { report: report[0], observed: report[1].observed, reviewed: report[1].reviewed } : {} });
  }
  /** A peer that `partner` resumed (tell_peer) is awaited like a worker of this wake when the wake owns that partner, or will once its launch is confirmed. */
  adopt(run: string, partner: string) {
    const since = this.now();
    if (this.owned.has(partner)) { this.own(run, since); return; }
    if ([...this.launches.values()].some(ids => ids.includes(partner))) this.adoptions.set(partner, [...this.adoptions.get(partner) ?? [], { run, since }]);
  }
  queued(report: string, ids: string[]) {
    if (this.reports.has(report)) return;
    const limit = this.now() + WORKER_DELIVERY_MS;
    this.reports.set(report, { ids, observed: false, reviewed: false, limit, at: this.now() });
    for (const id of ids) {
      const pending = this.owned.get(id);
      if (pending) { pending.report = report; pending.limit = limit; pending.deadline = limit; }
    }
  }
  observed(report: string) {
    const queued = this.reports.get(report);
    if (queued) queued.observed = true;
    for (const pending of this.owned.values()) if (pending.report === report && !pending.observed) {
      pending.observed = true; pending.deadline = Infinity;
    }
    if (report === WORKER_RECOVERY && this.recovery && !this.recovery.observed) {
      this.recovery.observed = true; this.recovery.deadline = Infinity;
    }
  }
  replied() {
    for (const report of this.reports.values()) if (report.observed) report.reviewed = true;
    for (const pending of this.owned.values()) if (pending.observed) pending.reviewed = true;
    if (this.recovery?.observed) this.recovery.reviewed = true;
  }
  settled(aborted: boolean) {
    if (aborted) {
      for (const pending of this.owned.values()) {
        pending.reviewed = false;
        if (pending.observed) pending.deadline = pending.limit;
        pending.observed = false;
      }
      for (const report of this.reports.values()) { report.reviewed = false; report.observed = false; }
      if (this.recovery) {
        this.recovery.reviewed = false;
        if (this.recovery.observed) this.recovery.deadline = this.recovery.limit;
        this.recovery.observed = false;
      }
      return;
    }
    for (const [id, pending] of this.owned) if (pending.reviewed) this.owned.delete(id);
    if (this.recovery?.reviewed) this.recovery = undefined;
  }
  hasReport(text: string) { return [...this.owned.values()].some(pending => pending.report === text); }
  completedReports() {
    return [...[...this.reports].filter(([, report]) => report.reviewed).map(([text]) => text),
      ...this.recovery?.reviewed ? [WORKER_RECOVERY] : []];
  }
  get holding() { return this.owned.size > 0 || this.recovery !== undefined; }
  get deadline() { return Math.min(...[...this.owned.values(), ...this.recovery ? [this.recovery] : []].map(pending => pending.deadline)); }
  expire(): 'recover' | 'finish' | undefined {
    if (this.now() < this.deadline) return;
    this.notVerified = true;
    if (this.recovery) { this.recovery = undefined; return 'finish'; }
    this.owned.clear();
    const limit = this.now() + WORKER_DELIVERY_MS;
    this.recovery = { deadline: limit, limit };
    return 'recover';
  }
  clear() { this.calls.clear(); this.launches.clear(); this.adoptions.clear(); this.owned.clear(); this.reports.clear(); this.recovery = undefined; this.notVerified = false; }
}
