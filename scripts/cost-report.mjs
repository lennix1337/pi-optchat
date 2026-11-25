import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { costReport, formatCostReport } from '../src/cost-delivery.ts';

try {
  const { values } = parseArgs({ options: {
    week: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean' },
    'profile-dir': { type: 'string' }, 'sessions-dir': { type: 'string' }, config: { type: 'string' }, merges: { type: 'string' },
  } });
  if (values.help) {
    console.log('node scripts/cost-report.mjs [--week YYYY-MM-DD] [--json] [--profile-dir DIR] [--sessions-dir DIR] [--config JSON] [--merges JSON]');
  } else {
    const profile = process.env.OPTCHAT_PROFILE;
    const dir = values['profile-dir'] ?? (profile && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(profile) ? join(process.env.OPTCHAT_HOME ?? join(homedir(), '.optchat'), 'profiles', profile) : undefined);
    if (!dir) throw new Error('Informe OPTCHAT_PROFILE ou --profile-dir.');
    const report = await costReport(dir, { week: values.week, sessions: values['sessions-dir'], config: values.config, merges: values.merges });
    console.log(values.json ? JSON.stringify(report, null, 2) : formatCostReport(report));
  }
} catch (error) {
  console.error(`Relatório de custos: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
}
