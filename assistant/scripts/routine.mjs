#!/usr/bin/env node
import { cli } from './cli.mjs';
import { loadConfig } from '../src/ops/service.ts';
import { openRoutineAdmin, parseRoutineTask, TASK_KIND } from '../src/routines/service.ts';

const usage = `Usage: node assistant/scripts/routine.mjs <command> --config <absolute-path> [options]
  list
  create --id <id> --title <task title> --channel <channel> --schedule <json> [--missed once|skip]
  resume --id <id> --by <operator>      activates it from now; time spent paused is never "missed"
  pause --id <id>
  delete --id <id>                      its run history stays
  history --id <id> [--limit <n>]
Schedules: {"kind":"daily","at":"HH:MM","timeZone":"<IANA>"}, {"kind":"weekly","days":[0..6],"at":"HH:MM","timeZone":"<IANA>"},
{"kind":"interval","minutes":<n>,"anchor":<epoch ms>}. A new routine is paused; it runs only after resume, in a service
started with "routines":true. Each due slot becomes one queued task in the channel; the draft executor takes it only
when that channel is one of its own. Running this command is the operator's authority; the service needs no restart.`;

const commands = {
  list: [], create: ['id', 'title', 'channel', 'schedule'], resume: ['id', 'by'], pause: ['id'], delete: ['id'], history: ['id'],
};
const optional = { create: ['missed'], history: ['limit'] };

cli(usage, {
  config: { type: 'string', required: true, path: true }, id: { type: 'string' }, title: { type: 'string' }, channel: { type: 'string' },
  schedule: { type: 'string' }, missed: { type: 'string' }, by: { type: 'string' }, limit: { type: 'string' },
}, async (values, positionals) => {
  const [command] = positionals;
  const needed = commands[command];
  const given = Object.keys(values).filter(key => key !== 'config' && values[key] !== undefined);
  if (positionals.length !== 1 || !needed || !needed.every(key => given.includes(key)) || !given.every(key => needed.includes(key) || optional[command]?.includes(key))) return { result: 'usage', exitCode: 2 };
  const config = loadConfig(values.config);
  if (config.routines !== true) throw new Error('routines_disabled');
  const admin = openRoutineAdmin(config.databasePath);
  try {
    const { routines } = admin;
    switch (command) {
      case 'list': return { result: 'ok', routines: routines.list(config.profileId) };
      case 'create': {
        let schedule;
        try { schedule = JSON.parse(values.schedule); } catch { throw new Error('invalid_schedule'); }
        const input = parseRoutineTask({ title: values.title, channelId: values.channel });
        return { result: 'created', routine: routines.create({ id: values.id, profileId: config.profileId, kind: TASK_KIND, input, schedule, ...(values.missed ? { missed: values.missed } : {}) }) };
      }
      case 'resume': return { result: 'active', routine: routines.resume(owned(routines, values.id, config), values.by) };
      case 'pause': return { result: 'paused', routine: routines.pause(owned(routines, values.id, config)) };
      case 'delete': routines.delete(owned(routines, values.id, config)); return { result: 'deleted' };
      case 'history': return { result: 'ok', runs: routines.history(owned(routines, values.id, config), values.limit === undefined ? 50 : Number(values.limit)) };
    }
  } finally { admin.close(); }
});

/** Only this profile's routines are managed here. */
function owned(routines, id, config) {
  if (routines.get(id).profileId !== config.profileId) throw new Error('unknown_routine');
  return id;
}
