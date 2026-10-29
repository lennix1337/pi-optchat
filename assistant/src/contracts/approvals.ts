import { object, oneOf, text, timestamp, version } from './validation.ts';
import { taskId } from './tasks.ts';
export type Approval = {
  version: 1;
  approvalId: string;
  profileId: string;
  taskId: string;
  runId: string;
  accountId: string;
  effect: string;
  destination: string;
  contentHash: string;
  expiresAt: string;
  policyVersion: string;
  ownerId: string;
  scope: 'once';
};
export function parseApproval(value: unknown): Approval {
  object(value, {
    version,
    approvalId: text,
    profileId: text,
    taskId,
    runId: text,
    accountId: text,
    effect: text,
    destination: text,
    contentHash: text,
    expiresAt: timestamp,
    policyVersion: text,
    ownerId: text,
    scope: oneOf('once'),
  });
  return value as Approval;
}
