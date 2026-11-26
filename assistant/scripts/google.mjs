#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { cli } from './cli.mjs';
import { loadConfig } from '../src/ops/service.ts';
import { GoogleLocal } from '../src/connectors/google-local.ts';
import { osKeyProtector } from '../src/secrets/protector.ts';

const usage = `Usage: node assistant/scripts/google.mjs <command> --config <absolute-path> [options]
  client --client-file <abs>         store Google's downloaded "Desktop app" client JSON (secret goes to the vault)
  connect --name <id> --email <addr> print a consent URL; open it, sign in as <addr>, approve; waits up to 5 minutes
  list                               connections and their state (no tokens)
  revoke --name <id>                 end local access, then revoke at Google
  briefing --name <id>[,<id>] [--tz <IANA>]           read mail and agenda now; items carry their source references
  start --briefing <id> --item <id> --name <id>[,<id>] [--tz <IANA>]   queue one briefing item as a local task
  draft --id <id>                    inspect a local reply draft; nothing is sent
  learn                              read one rule from stdin: Hide <text> [unless <term> or <term>] because <reason>
  rules                              list this profile's learned rules and their IDs
  forget --id <id>                   remove a learned rule for future briefings
Scopes are read-only (openid, email, gmail.readonly, calendar.readonly); nothing is sent. Windows DPAPI only.`;

const names = value => String(value ?? '').split(',').filter(Boolean);
cli(usage, {
  config: { type: 'string', required: true, path: true }, 'client-file': { type: 'string', path: true },
  name: { type: 'string' }, email: { type: 'string' }, tz: { type: 'string' }, briefing: { type: 'string' }, item: { type: 'string' }, id: { type: 'string' },
}, async (values, [command]) => {
  const config = loadConfig(values.config);
  const local = await GoogleLocal.open({ databasePath: config.databasePath, profileId: config.profileId, protector: osKeyProtector() });
  const tz = values.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  try {
    switch (command) {
      case 'client':
        if (!values['client-file']) throw new Error('usage');
        return { result: 'client_saved', ...local.setClient(readFileSync(values['client-file'], 'utf8')), note: 'the downloaded client file can be deleted now' };
      case 'connect': {
        const connection = await local.connect({ name: values.name, email: values.email, onUrl: url => { console.error(`Open this URL in your browser and approve read-only access:\n${url}`); } });
        return { result: 'connected', connection };
      }
      case 'list': return { result: 'ok', connections: local.list() };
      case 'revoke': return { result: 'revoked', ...(await local.revoke(values.name)) };
      case 'briefing': return { result: 'ok', briefing: await local.briefing(names(values.name), tz) };
      case 'start': return { result: 'queued', task: await local.start(values.briefing, values.item, names(values.name), tz) };
      case 'draft': {
        const draft = values.id && await local.withComposer([], tz, composer => composer.draft(values.id));
        if (!draft) throw new Error('draft_unknown');
        return { result: 'draft', draft };
      }
      case 'learn': {
        let text = '';
        process.stdin.setEncoding('utf8');
        for await (const chunk of process.stdin) {
          text += chunk;
          if (text.length > 1002) throw new Error('invalid_triage_rule');
        }
        return { result: 'learned', rule: await local.learnRule(text, tz) };
      }
      case 'rules': return { result: 'ok', rules: await local.withComposer([], tz, composer => composer.learnedRules()) };
      case 'forget': {
        if (!values.id || !await local.forgetRule(values.id, tz)) throw new Error('triage_rule_unknown');
        return { result: 'forgotten', ruleId: values.id };
      }
      default: console.error(usage); return { result: 'usage', exitCode: 2 };
    }
  } finally { local.close(); }
});
