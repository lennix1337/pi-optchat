// Isolation for disposable benches that load the real extension: they build their own OPTCHAT_HOME from an allowlist of
// the profile's data files, so no live-service config (assistant.json: endpoint + token of the operator's assistant
// service, which turns every turn into a real task and desktop toast) is ever copied, and they refuse to start otherwise.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';

/** Data the memory, runs and usage code read; everything else in a profile (assistant.json, Slack/WhatsApp state, approvals, sync) stays behind. */
export const COPIED = ['main', 'tree', 'view.json', 'head.json', 'runs', 'usage.jsonl', 'usage.db', 'crew', 'outputs'] as const;

/** Files and keys that point at a live service or hold its credential. */
const LIVE_FILES = /^(assistant\.json|assistant-health\.json|slack-.*\.json|ai-memory-sync\.json|optmem-sync\.json|autonomy\.json)$/;
const LIVE_KEYS = /^(endpoint|token|apiKey|webhook|webhookUrl|secret|password)$/i;

const inside = (parent: string, child: string) => { const path = relative(resolve(parent), resolve(child)); return path === '' || (!path.startsWith('..') && !isAbsolute(path)); };
const real = (path: string) => { try { return realpathSync(path); } catch { return resolve(path); } };

/** Throws when `home` could reach live state: the operator's real data home (or inside it), or a profile that carries service config. */
export function assertSandbox(home: string, realHome = join(process.env.USERPROFILE ?? homedir(), '.optchat')) {
  const sandbox = real(home), live = real(realHome);
  if (inside(live, sandbox) || inside(sandbox, live)) throw new Error(`Refusing to run: ${home} is the real OptChat home or contains/sits inside it (${realHome}).`);
  const profiles = join(sandbox, 'profiles');
  for (const profile of existsSync(profiles) ? readdirSync(profiles) : []) {
    const dir = join(profiles, profile);
    for (const file of readdirSync(dir, { withFileTypes: true })) {
      if (LIVE_FILES.test(file.name)) throw new Error(`Refusing to run: ${join(dir, file.name)} configures a live service; remove it from the copy.`);
      if (file.isFile() && file.name.endsWith('.json') && file.name !== 'config.json') {
        let parsed: unknown;
        try { parsed = JSON.parse(readFileSync(join(dir, file.name), 'utf8')); } catch { continue; }
        const keys = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? Object.keys(parsed) : [];
        const hit = keys.find(key => LIVE_KEYS.test(key));
        if (hit) throw new Error(`Refusing to run: ${join(dir, file.name)} holds "${hit}", a live-service endpoint or credential.`);
      }
    }
  }
}

/** Copies the allowlisted data of `source` (a profile directory, read only) into `<home>/profiles/<name>` and returns that directory. */
export function copyProfile(source: string, home: string, name: string) {
  const target = join(home, 'profiles', name);
  mkdirSync(target, { recursive: true });
  for (const entry of COPIED) if (existsSync(join(source, entry))) cpSync(join(source, entry), join(target, entry), { recursive: true });
  return target;
}

/** Makes every network call from this process fail, for a bench whose model is a local fixture: nothing may leave the machine or reach loopback services. */
export function blockNetwork() {
  const refused = (url: unknown) => Promise.reject(new TypeError(`bench sandbox: network access refused (${String(url instanceof Request ? url.url : url)})`));
  globalThis.fetch = ((url: unknown) => refused(url)) as typeof fetch;
}
