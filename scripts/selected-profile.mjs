import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function selectedProfile(root = process.env.OPTCHAT_HOME ?? join(homedir(), '.optchat')) {
  let name;
  try { name = readFileSync(join(root, 'last-profile'), 'utf8').trim(); }
  catch (error) {
    if (error.code === 'ENOENT') return 'default';
    throw error;
  }
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) throw new Error('Invalid last-profile');
  return name;
}

export function selectedProfileDir(root = process.env.OPTCHAT_HOME ?? join(homedir(), '.optchat')) {
  return join(root, 'profiles', selectedProfile(root));
}
