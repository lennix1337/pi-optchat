import type { DisplayPreference, DisplayProposal } from '../memory/display-learning.ts';
import type { NotificationRecord } from '../notifications/center.ts';

/** Read-only product observations. No approval, learning mutation or delivery method crosses this port. */
export type PanelInspection = {
  learning: { current: DisplayPreference; proposals: DisplayProposal[] } | null;
  notices: NotificationRecord[] | null;
};
export type InspectionSource = () => PanelInspection;
