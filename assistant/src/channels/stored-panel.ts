import type { IncomingMessage, ServerResponse } from 'node:http';
import { briefingView, type StoredBriefings } from '../briefing/view.ts';
import { query, send } from '../http/io.ts';
import type { InspectionSource } from './inspection.ts';

/** Stored observations only. Authentication/revocation remain owned by WebChannel. */
export class StoredPanel {
  private readonly profileId: string;
  private readonly briefings: StoredBriefings | undefined;
  private readonly inspection: InspectionSource | undefined;
  constructor(profileId: string, briefings?: StoredBriefings, inspection?: InspectionSource) {
    this.profileId = profileId; this.briefings = briefings; this.inspection = inspection;
  }
  async handle(req: IncomingMessage, res: ServerResponse, url: URL, headers: Record<string, string>, stillCurrent: () => boolean): Promise<boolean> {
    if (req.method !== 'GET') return false;
    if (url.pathname === '/web/api/inspection' && this.inspection) {
      query(url, []); send(res, 200, this.inspection(), headers); return true;
    }
    if (url.pathname !== '/web/api/briefing' || !this.briefings) return false;
    query(url, []);
    const latest = await this.briefings.latest();
    if (!stillCurrent()) { send(res, 401, { error: 'Unauthorized' }, headers); return true; }
    const value = briefingView(latest, this.profileId);
    send(res, value ? 200 : 404, value ?? { error: 'Not found' }, headers); return true;
  }
}
