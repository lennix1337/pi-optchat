

import { registerHooks } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const release = process.env.PI_BENCH_RELEASE;
if (!release) throw new Error('PI_BENCH_RELEASE must name the Pi release directory to benchmark');
const packages = join(release, 'node_modules', '@earendil-works');
const source = new URL('../src/', import.meta.url).href;
registerHooks({ resolve(specifier, context, next) {
  const match = /^@earendil-works\/(pi-coding-agent|pi-agent-core|pi-ai|pi-tui)(?:\/(.*))?$/.exec(specifier);
  if (!match) return next(specifier, context);
  const [, pkg, sub] = match;
  if (!sub && pkg === 'pi-ai' && context.parentURL?.startsWith(source)) {
    return { url: pathToFileURL(join(packages, 'pi-coding-agent', 'dist/core/extensions/pi-ai-extension-view.js')).href, shortCircuit: true };
  }
  let target;
  if (!sub) target = 'dist/index.js';
  else if (pkg === 'pi-ai' && /^(models|compat|oauth|bedrock-provider|bun-oauth|lazy-bedrock-provider|lazy-oauth|(?:providers|api|utils)\/[\w.-]+)$/.test(sub)) target = `dist/${sub}.js`;
  else if (pkg === 'pi-coding-agent' && sub === 'rpc-entry') target = 'dist/bundle/rpc-entry.js';
  else if (sub === 'package.json') target = sub;
  else throw new Error(`unmapped Pi release import ${specifier}`);
  return { url: pathToFileURL(join(packages, pkg, target)).href, shortCircuit: true };
} });
await import('./bench-session-run.ts');
