/** The most characters of report text one bundled message carries; a longer report is sent alone, whole. */
export const BUNDLE_CHARS = 20_000;
/** Between two reports of a bundle: the same blank line a grouped spawn report uses, so every report keeps its own `[id]` header. */
export const BUNDLE_SEPARATOR = '\n\n';

/** A report waiting for delivery, or a bundle of consecutive ones (`members`): its text is theirs joined. */
export interface Bundleable<R> { text: string; count?: number; members?: R[] }

/**
 * Packs the reports waiting, in order, into the messages that carry them: consecutive reports share one message until its text
 * would pass `max` characters, and a `solo` report always travels alone. A bundle among `waiting` is opened first, so packing
 * what is still waiting after a send never nests. A lone report stays itself (no bundle object, no change to its text).
 */
export function packReports<R extends Bundleable<R>>(waiting: readonly R[], solo: (report: R) => boolean, make: (members: R[], text: string, count: number) => R, max = BUNDLE_CHARS): R[] {
  const out: R[] = [];
  let group: R[] = [], size = 0;
  const close = () => {
    if (group.length > 1) out.push(make(group, group.map(r => r.text).join(BUNDLE_SEPARATOR), group.reduce((sum, r) => sum + (r.count ?? 1), 0)));
    else out.push(...group);
    group = []; size = 0;
  };
  for (const report of waiting.flatMap(r => r.members ?? [r])) {
    if (solo(report)) { close(); out.push(report); continue; }
    const added = report.text.length + (group.length ? BUNDLE_SEPARATOR.length : 0);
    if (group.length && size + added > max) close();
    size += group.length ? added : report.text.length;
    group.push(report);
  }
  close();
  return out;
}
