import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { loadEconomy } from './quota-economy.ts';
import { reportText } from './quota-format.ts';
import { QUOTA_FILE } from './quota-health.ts';
import { readJsonOr } from './store.ts';

/** The terminal's `/cota`: the table `cota` answers in Slack plus the weekly comparison, from the cache and the profile's files; no provider is called. */
export function quotaCommandText(dir: string | undefined, now: number, cacheFile = QUOTA_FILE): string {
  const state = readJsonOr<unknown>(cacheFile, {});
  return reportText(state, dir ? loadEconomy({ dir, now, cacheFile }) : { now, accounts: [], weeks: [] });
}

export function registerQuotaCommand(pi: ExtensionAPI, dir: () => string | undefined, cacheFile = QUOTA_FILE): void {
  pi.registerCommand('cota', {
    description: 'Quota of every model account: % used and when each window resets (Brasília time), US$ per 1% and the week against the one before (cached reading, no model call)',
    handler: async (_args, ctx) => { ctx.ui.notify(quotaCommandText(dir(), Date.now(), cacheFile), 'info'); },
  });
}
