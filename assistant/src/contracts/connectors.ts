import { object, oneOf, strings, text, version } from './validation.ts';
export type Connector = {
  version: 1;
  connectorId: string;
  profileId: string;
  accountId: string;
  serverId: string;
  schemaHash: string;
  grantedCapabilities: string[];
  effect: 'read' | 'write' | 'unknown';
  secretRef: string;
};
export function parseConnector(value: unknown): Connector {
  object(value, {
    version,
    connectorId: text,
    profileId: text,
    accountId: text,
    serverId: text,
    schemaHash: text,
    grantedCapabilities: strings,
    effect: oneOf('read', 'write', 'unknown'),
    secretRef: text,
  });
  return value as Connector;
}
