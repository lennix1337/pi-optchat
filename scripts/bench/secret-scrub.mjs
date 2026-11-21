import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { scrubSecrets } from '../../src/secret-scrub.ts';

const PLANTED_SECRETS = [
  { type: 'slack-xoxb', raw: 'xo' + 'xb-123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx' },
  { type: 'slack-xoxp', raw: 'xo' + 'xp-998877665544-112233445566-ZyXwVuTsRqPoNmLkJiHgFeDc' },
  { type: 'github-ghp', raw: 'ghp_1234567890abcdefghijklmnopqrstuvwxyzABCD' },
  { type: 'github-pat', raw: 'github_pat_11ABCDEFG0123456789_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789' },
  { type: 'openai-sk', raw: 'sk-proj-AbCdEf123456GhIjKl789012MnOpQr345678StUvWx' },
  { type: 'anthropic-sk', raw: 'sk-ant-api03-AbCdEf123456GhIjKl789012MnOpQr345678StUvWx' },
  { type: 'aws-akia', raw: 'AKIAIOSFODNN7EXAMPLE' },
  { type: 'google-aiza', raw: 'AIzaSyDaGmWKa4JsXZ-HjGw7ISLn_3namBGew123' },
  { type: 'jwt', raw: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c' },
  { type: 'bearer', raw: 'Bearer tok_live_9876543210fedcbaABCDEF', secretPart: 'tok_live_9876543210fedcbaABCDEF' },
  { type: 'env-line', raw: 'DATABASE_SECRET=my_super_secret_db_pass_9911', secretPart: 'my_super_secret_db_pass_9911' },
  { type: 'env-export', raw: 'export SENTRY_AUTH_TOKEN="sntrys_eyJpYXQiOjE3MDAwMDAwMDB9_AbCdEf123456"', secretPart: 'sntrys_eyJpYXQiOjE3MDAwMDAwMDB9_AbCdEf123456' },
  { type: 'url-auth', raw: 'https://deploy_user:s3cr3tP4ssw0rd!@registry.example.com/pkg', secretPart: 's3cr3tP4ssw0rd!' },
  { type: 'entropy-standalone', raw: '9fK2mP8xQ4vL7nR3wZ6yB1cT5jH0dG8sA' },
];

const NEGATIVE_SAMPLES = [
  'C:\\Projetos\\pi-optchat\\worktrees\\agy-oh-scrub\\src\\memory.ts',
  '/home/user/projects/pi-optchat/node_modules/@earendil-works/pi-coding-agent/dist/index.js',
  'commit a3f5b8c9d1e2f4a6b7c8d9e0f1a2b3c4d5e6f7a8',
  'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  '550e8400-e29b-41d4-a716-446655440000',
  'PR #288 merged into main (https://github.com/jonaslsaa/pi-optchat/pull/288)',
  'https://api.example.com/v2/users/12345/profile?page=2&limit=50',
  'PWD=C:\\Projetos\\pi-optchat\nNODE_ENV=production\nPORT=3000\nSSL_KEY_PATH=/etc/ssl/private/app.pem',
];

function buildRealCorpus() {
  const chunks = [...NEGATIVE_SAMPLES];
  const srcDir = join(process.cwd(), 'src');
  for (const name of readdirSync(srcDir).sort()) {
    if (name.endsWith('.ts') && name !== 'secret-scrub.ts') {
      chunks.push(readFileSync(join(srcDir, name), 'utf8'));
    }
  }
  chunks.push(readFileSync(join(process.cwd(), 'docs/research/openhuman-comparison.md'), 'utf8'));
  return chunks.join('\n');
}

const syntheticDoc = PLANTED_SECRETS.map((s, i) => s.type.startsWith('env-') ? `${i + 1}: ${s.raw}` : `line ${i} (${s.type}): ${s.raw}`).join('\n');
const scrubbedSynthetic = scrubSecrets(syntheticDoc);
let caught = 0;
const missed = [];
for (const s of PLANTED_SECRETS) {
  const needle = s.secretPart ?? s.raw;
  if (!scrubbedSynthetic.includes(needle)) caught++;
  else missed.push(s.type);
}
const recallPct = Math.round((caught / PLANTED_SECRETS.length) * 10000) / 100;

const realCorpus = buildRealCorpus();
const scrubbedReal = scrubSecrets(realCorpus);
const fpMatches = scrubbedReal.match(/\[segredo:[^\]]+\]/g) ?? [];


const targetBytes = 10 * 1024 * 1024;
const repeats = Math.max(1, Math.ceil(targetBytes / Buffer.byteLength(realCorpus, 'utf8')));
const totalMb = (repeats * Buffer.byteLength(realCorpus, 'utf8')) / (1024 * 1024);


scrubSecrets(realCorpus.slice(0, 65536));

const t0 = performance.now();
for (let i = 0; i < repeats; i++) scrubSecrets(realCorpus);
const elapsedMs = performance.now() - t0;
const msPerMb = Math.round((elapsedMs / totalMb) * 1000) / 1000;

if (process.argv.includes('--verbose')) {
  console.error({
    planted: PLANTED_SECRETS.length,
    caught,
    missed,
    recallPct,
    realCorpusBytes: Buffer.byteLength(realCorpus, 'utf8'),
    falsePositives: fpMatches.length,
    fpSamples: fpMatches.slice(0, 10),
    totalMb: Math.round(totalMb * 100) / 100,
    elapsedMs: Math.round(elapsedMs * 100) / 100,
    msPerMb,
  });
}

console.log(JSON.stringify({
  metric: 'secret-scrub-ms-per-mb',
  value: msPerMb,
  unit: 'ms/MB',
  lowerIsBetter: true,
  recallPct,
  falsePositives: fpMatches.length,
}));
