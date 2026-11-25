export const isCommitSha = sha => typeof sha === 'string' && /^[0-9a-f]{40}$/i.test(sha);
export const hasBinaryPatch = patch => /^(?:Binary files .+ differ|GIT binary patch)\r?$/m.test(patch);

export class IncompletePrHistory extends Error {
  constructor(options) { super('Não consegui confirmar o histórico completo da PR.', options); }
}

function historyJson(text) {
  try { return JSON.parse(text); } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new IncompletePrHistory({ cause: error });
  }
}

export async function remoteHistory(pr, read) {
  const ref = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)$/.exec(pr.url ?? '');
  if (!ref || ref[2] !== String(pr.number) || !isCommitSha(pr.headRefOid)) throw new IncompletePrHistory();
  const root = `repos/${ref[1]}`;
  const pages = historyJson(await read(['api', '--paginate', '--slurp', `${root}/pulls/${pr.number}/commits`]));
  if (!Array.isArray(pages) || pages.some(page => !Array.isArray(page))) throw new IncompletePrHistory();
  const commits = pages.flat();
  // external: The GitHub pull-commits endpoint caps results at 250 even when paginated.
  if (!commits.length || commits.length >= 250 || commits.at(-1)?.sha !== pr.headRefOid
    || commits.some(c => !isCommitSha(c?.sha) || typeof c.commit?.message !== 'string')) throw new IncompletePrHistory();
  if (new Set(commits.map(c => c.sha)).size !== commits.length) throw new IncompletePrHistory();

  const patches = [];
  let bytes = 0;
  for (const { sha } of commits) {
    const endpoint = `${root}/commits/${sha}`;
    const patch = await read(['api', endpoint, '--header=Accept:application/vnd.github.diff']);
    bytes += Buffer.byteLength(patch);
    if (bytes > 16 * 1024 * 1024 || hasBinaryPatch(patch)) throw new IncompletePrHistory();
    if (!patch.trim()) {
      const details = historyJson(await read(['api', endpoint]));
      if (details?.sha !== sha || !Array.isArray(details.files) || details.files.length !== 0) throw new IncompletePrHistory();
    }
    patches.push(patch);
  }
  return { history: patches.join('\n'), commitMessages: commits.map(({ sha, commit }) => ({ sha, message: commit.message })) };
}
