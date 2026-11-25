export const isCommitSha = sha => typeof sha === 'string' && /^[0-9a-f]{40}$/i.test(sha);

export class IncompletePrHistory extends Error {
  constructor(options) { super('Não consegui confirmar o histórico completo da PR.', options); }
}

export async function remoteHistory(pr, read) {
  const ref = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)$/.exec(pr.url ?? '');
  if (!ref || ref[2] !== String(pr.number) || !isCommitSha(pr.headRefOid)) throw new IncompletePrHistory();
  const root = `repos/${ref[1]}`;
  const list = await read(['api', '--paginate', '--slurp', `${root}/pulls/${pr.number}/commits`]);
  let pages;
  try { pages = JSON.parse(list); } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new IncompletePrHistory();
  }
  if (!Array.isArray(pages) || pages.some(page => !Array.isArray(page))) throw new IncompletePrHistory();
  const commits = pages.flat();
  // external: The GitHub pull-commits endpoint caps results at 250 even when paginated.
  if (!commits.length || commits.length >= 250 || commits.at(-1)?.sha !== pr.headRefOid
    || commits.some(c => !isCommitSha(c?.sha) || typeof c.commit?.message !== 'string')) throw new IncompletePrHistory();
  if (new Set(commits.map(c => c.sha)).size !== commits.length) throw new IncompletePrHistory();

  const patches = [];
  let bytes = 0;
  for (const { sha } of commits) {
    const patch = await read(['api', `${root}/commits/${sha}`, '--header=Accept:application/vnd.github.diff']);
    bytes += Buffer.byteLength(patch);
    if (bytes > 16 * 1024 * 1024 || /^(?:Binary files .+ differ|GIT binary patch)\r?$/m.test(patch)) throw new IncompletePrHistory();
    patches.push(patch);
  }
  return { history: patches.join('\n'), commitMessages: commits.map(({ sha, commit }) => ({ sha, message: commit.message })) };
}
