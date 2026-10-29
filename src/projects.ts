import type { AgentMessage } from '@earendil-works/pi-agent-core';

/** The operator's projects as Slack channels: a repository folder under C:/projetos (or a GitHub repo name) -> channel. */
export const PROJECTS = ['dentai', 'genexus18mcp', 'harness'] as const;
export type Project = typeof PROJECTS[number];
const REPOS: [RegExp, Project][] = [[/^dentai/i, 'dentai'], [/^genexus18mcp/i, 'genexus18mcp'], [/^(?:pi-|dotfiles$|ripwire$|local-validation$)/i, 'harness']];

/** The project of one repository name, e.g. `dentai-mono`, `pi-optchat`, `GeneXus18MCP`. */
export const projectOfRepo = (repo: string): Project | undefined => REPOS.find(([pattern]) => pattern.test(repo))?.[1];

/** The project most mentioned by `projetos/<repo>` paths in a text (a command, a cwd, tool arguments). */
export function projectOf(...texts: (string | undefined)[]): Project | undefined {
  const hits = new Map<Project, number>();
  for (const text of texts)
    for (const [, repo] of (text ?? '').matchAll(/projetos[\\/]+([\w.-]+)/gi)) {
      const project = projectOfRepo(repo!);
      if (project) hits.set(project, (hits.get(project) ?? 0) + 1);
    }
  return [...hits].sort((a, b) => b[1] - a[1])[0]?.[0];
}

export type ToolCall = { name: string; arguments: unknown };
export const toolCalls = (messages: readonly AgentMessage[]): ToolCall[] => messages.flatMap(m => m.role === 'assistant'
  ? m.content.flatMap(part => part.type === 'toolCall' ? [{ name: part.name, arguments: part.arguments }] : []) : []);
/** A call that changed something: a file edit, a commit, a push or a PR. Reads and checks deliver nothing. */
export const delivers = (call: ToolCall) => call.name === 'edit' || call.name === 'write'
  || (call.name === 'bash' && /\bgit\s+(?:commit|push)\b|\bgh\s+pr\s+(?:create|merge)\b/.test(JSON.stringify(call.arguments)));

/** The project a run worked on: where its delivering calls went, else where any of its calls went. */
export function projectOfRun(messages: readonly AgentMessage[]): Project | undefined {
  const calls = toolCalls(messages);
  const args = (list: ToolCall[]) => list.map(call => JSON.stringify(call.arguments));
  return projectOf(...args(calls.filter(delivers))) ?? projectOf(...args(calls));
}
