import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Each guard is removed from a disposable copy of the source; the named test must then fail for the stated reason.
const assistant = dirname(dirname(fileURLToPath(import.meta.url)));
const root = mkdtempSync(join(tmpdir(), 'assistant-google-mutations-'));
const google = 'src/connectors/google.ts';
const mutations = [
  ['OAuth state check', google, "const pending = this.pending.get(state) ?? fail('google_state_invalid');", 'const pending = this.pending.get(state) ?? [...this.pending.values()][0];', 'google-oauth.test.ts', 'a forged, replayed or expired state', /Missing expected rejection/],
  ['exact redirect check', google, "if (`${callback.origin}${callback.pathname}` !== this.redirectUri || callback.username || callback.password) fail('google_redirect_mismatch');", '', 'google-oauth.test.ts', 'a callback on another path', /Missing expected rejection/],
  ['PKCE S256 challenge', google, "code_challenge: createHash('sha256').update(verifier).digest('base64url')", 'code_challenge: verifier', 'google-oauth.test.ts', 'a completed authorization stores tokens', /google_token_exchange_failed/],
  ['PKCE verifier sent', google, 'code_verifier: pending.verifier, ', '', 'google-oauth.test.ts', 'a completed authorization stores tokens', /google_token_exchange_failed/],
  ['identity bound to expected account', google, "if (identity.email !== pending.expectedEmail) fail('google_account_mismatch');", '', 'google-oauth.test.ts', 'the verified identity must be the expected account', /Missing expected rejection/],
  ['identity nonce', google, ' && claims.nonce === nonce', '', 'google-oauth.test.ts', 'an id_token for another client', /Missing expected rejection/],
  ['connection keeps its subject', google, "if (replaced?.state === 'active' && replaced.subject !== identity.subject) fail('google_account_mismatch');", '', 'google-oauth.test.ts', 'personal and DentAI are separate', /Missing expected rejection/],
  ['read-only scope ceiling', google, "names.add(GRANTED_SCOPE_NAMES.get(granted) ?? fail('google_scope_mismatch'));", 'names.add(GRANTED_SCOPE_NAMES.get(granted) ?? granted);', 'google-oauth.test.ts', 'a broader grant than read-only', /Missing expected rejection/],
  ['local revocation', google, `this.db.prepare("UPDATE google_connections SET state = 'revoked' WHERE profile = ? AND connection_id = ?").run(this.options.profileId, row.connection_id);`, '', 'google-oauth.test.ts', 'revocation removes access locally', /google_connection_revoked/],
  ['stored tokens erased on revocation', google, 'for (const ref of [row.access_ref, row.refresh_ref]) this.options.vault.revoke(ref, this.options.profileId);', '', 'google-oauth.test.ts', 'a failed remote revocation', /The expression evaluated to a falsy value/],
  ['per-read scope check', google, "if (!(JSON.parse(row.scopes) as string[]).includes(scope)) fail('google_scope_missing');", '', 'google-boundaries.test.ts', 'a source read without its granted scope', /google_request_failed/],
  ['send grant check', google, 'return this.options.gateway.dispatch(this.effect(draft, write), sink);', 'return Promise.resolve(sink(Buffer.from(this.preview(draft).content), this.effect(draft, write)));', 'google-boundaries.test.ts', 'sending goes only through the gateway', /Missing expected rejection/],
  ['injection isolation in triage', 'src/briefing/triage.ts', "if (suspectedInjection) return result('normal', 'suspected_injection', 'high');", '', 'triage.test.ts', 'message text cannot change the rules', /urgent wording does not lift a suspected injection/],
  ['Start needs the operator authority', 'src/briefing/compose.ts', "if (authority !== this.options.operatorAuthority) fail('unauthorized');", '', 'briefing.test.ts', 'journey', /Missing expected exception/],
  ['one daily briefing per local date', 'src/briefing/compose.ts', "\n      CREATE UNIQUE INDEX IF NOT EXISTS briefings_daily ON briefings (profile, local_date) WHERE kind = 'daily';", '', 'briefing.test.ts', 'one daily briefing per profile', /concurrent clients share one daily briefing|one stored daily briefing/],
];
const tests = ['google-oauth.test.ts', 'google-boundaries.test.ts', 'triage.test.ts', 'briefing.test.ts'];
function run(dir, file, name) {
  const result = spawnSync(process.execPath, ['--test', '--test-timeout=60000', '--test-name-pattern', name, join(dir, 'test', file)], { encoding: 'utf8', timeout: 180_000 });
  if (result.error || result.signal) throw new Error(`Test process failed to run: ${result.error ?? result.signal}`);
  return { status: result.status, output: result.stdout + result.stderr };
}
try {
  const baseline = join(root, 'baseline');
  cpSync(join(assistant, 'src'), join(baseline, 'src'), { recursive: true });
  cpSync(join(assistant, 'test'), join(baseline, 'test'), { recursive: true });
  for (const file of tests) {
    const result = run(baseline, file, '.');
    if (result.status !== 0 || !/ℹ pass [1-9]/.test(result.output) || !/ℹ fail 0/.test(result.output)) throw new Error(`Baseline ${file} failed:\n${result.output}`);
    console.log(`baseline ${file}: passed`);
  }
  for (const [index, [name, file, before, after, testFile, testName, expected]] of mutations.entries()) {
    const dir = join(root, `mutation-${index}`);
    cpSync(baseline, dir, { recursive: true });
    const path = join(dir, file);
    const source = readFileSync(path, 'utf8');
    if (source.split(before).length !== 2) throw new Error(`${name}: mutation anchor not unique`);
    writeFileSync(path, source.replace(before, after));
    const result = run(dir, testFile, testName);
    if (result.status === 0 || !/ℹ fail [1-9]/.test(result.output) || !expected.test(result.output)) throw new Error(`${name}: mutation not detected as intended:\n${result.output}`);
    console.log(`${name}: detected (${expected.source})`);
  }
  console.log(`${mutations.length} mutations detected`);
} finally { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
