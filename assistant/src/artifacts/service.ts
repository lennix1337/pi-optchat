import { realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, parse } from 'node:path';
import { prepareDatabase } from '../store/privacy.ts';
import { createPrivateDirectory } from '../store/private-directory.ts';
import { ArtifactRegistry } from './registry.ts';

/** Open the private registry alongside the task database. Call close after HTTP requests drain. */
export function openArtifactService(options: { databasePath: string; profileId: string; sourceRoots?: string[] }): ArtifactRegistry {
  const configured = options.sourceRoots;
  if (!isAbsolute(options.databasePath) || (configured !== undefined && (!configured.length || configured.some(root => !isAbsolute(root))))) throw new Error('invalid_options');
  const sourceRoots = configured?.map(root => realpathSync(root));
  if (sourceRoots?.some(root => root === parse(root).root)) throw new Error('invalid_options');
  const root = join(dirname(options.databasePath), 'artifacts');
  createPrivateDirectory(root);
  // The HTTP reader needs no producer root; registration CLI always supplies one explicitly.
  return openRegistry(root, { ...options, sourceRoots: sourceRoots ?? [root] });
}

function openRegistry(root: string, options: { profileId: string; sourceRoots: string[] }): ArtifactRegistry {
  const databasePath = join(root, 'registry.sqlite');
  prepareDatabase(databasePath);
  return new ArtifactRegistry({ databasePath, profileId: options.profileId, root, sourceRoots: options.sourceRoots });
}
