#!/usr/bin/env node
import { cli } from './cli.mjs';
import { loadConfig } from '../src/ops/service.ts';
import { openArtifactService } from '../src/artifacts/service.ts';

const usage = `Usage: node assistant/scripts/artifact.mjs <list|register> --config <absolute-path> --source-root <absolute-directory> [options]
  register --source <absolute-file> --type <type> --owner <id> --producer <id> --provenance <reference> [--artifact-id <id>]
  list [--type <type>]
The source root is an explicit trusted producer directory, not a filesystem root. Do not put secrets in arguments or metadata.`;

cli(usage, {
  config: { type: 'string', required: true, path: true }, 'source-root': { type: 'string', required: true, path: true },
  source: { type: 'string', path: true }, type: { type: 'string' }, owner: { type: 'string' },
  producer: { type: 'string' }, provenance: { type: 'string' }, 'artifact-id': { type: 'string' },
}, async (values, positionals) => {
  const [command] = positionals;
  const register = command === 'register' && values.source && values.type && values.owner && values.producer && values.provenance;
  const list = command === 'list' && !values.source && !values.owner && !values.producer && !values.provenance && !values['artifact-id'];
  if (positionals.length !== 1 || (!register && !list)) return { result: 'usage', exitCode: 2 };
  const config = loadConfig(values.config);
  let registry;
  try {
    registry = openArtifactService({ databasePath: config.databasePath, profileId: config.profileId, sourceRoots: [values['source-root']] });
    if (list) return { result: 'ok', ...registry.list(values.type) };
    return { result: 'registered', artifact: registry.register({ sourcePath: values.source, type: values.type, ownerId: values.owner, producerId: values.producer, provenance: values.provenance, ...(values['artifact-id'] ? { artifactId: values['artifact-id'] } : {}) }) };
  } catch (error) {
    const code = error instanceof Error && /^artifact_[a-z_]+$/.test(error.message) ? error.message : 'artifact_service_failed';
    throw new Error(code);
  } finally { registry?.close(); }
});
