import type { DisplayPreference, DisplayProposal } from '../memory/display-learning.ts';
import type { NotificationRecord } from '../notifications/center.ts';
import type { RestoreHold } from '../store/db.ts';

/** Read-only product observations. No approval, learning mutation or delivery method crosses this port. */
export type PanelInspection = {
  learning: { current: DisplayPreference; proposals: DisplayProposal[] } | null;
  notices: NotificationRecord[] | null;
  /** Queued or working revisions held by a restore: the executor starts nothing for them until the operator reconciles. */
  restored: RestoreHold[];
};
export type InspectionSource = () => PanelInspection;
