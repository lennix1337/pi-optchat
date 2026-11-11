/** What every worker of a project has in common, so Anthropic's prompt cache builds it once. A worker's first message is the project brief
 *  (constant text, charter, memory, specialist view), then the run's own part (kind, peer, model, working directory, contract). Pi marks the
 *  end of the tools, of the system prompt and of the last message; none falls where the brief ends, so a second worker of the project found
 *  nothing of the brief in the cache and wrote it again. markBriefPrefix puts a mark there. */

/** The brief's per-run part starts with this line label: the text before it is the same for every worker of the project. */
export const RUN_LABEL = '[This run] ';
export const RUN_MARK = `\n\n${RUN_LABEL}`;
const BRIEF = '[Worker brief]';
/** Anthropic accepts at most this many cache marks in one request. */
const MARKS = 4;

type Block = Record<string, unknown>;
const record = (value: unknown): value is Block => typeof value === 'object' && value !== null && !Array.isArray(value);
const blocks = (value: unknown) => Array.isArray(value) ? value.filter(record) : [];

/** Every block of the request that carries a cache mark: tools, system blocks, message blocks. */
function marked(payload: Block) {
  const found: Block[] = [];
  for (const item of [...blocks(payload.tools), ...blocks(payload.system)]) if (item.cache_control) found.push(item);
  for (const message of blocks(payload.messages)) for (const block of blocks(message.content)) if (block.cache_control) found.push(block);
  return found;
}

/** Splits the first user message of a contract worker's request at the end of its brief and marks the brief block, in place. Does nothing
 *  when the request has no brief, when Pi put no marks at all (caching is off), or when a fifth mark would not fit. */
export function markBriefPrefix(payload: unknown): unknown {
  if (!record(payload) || !Array.isArray(payload.messages)) return payload;
  const first = payload.messages.find(message => record(message) && message.role === 'user');
  if (!record(first)) return payload;
  const content = typeof first.content === 'string' ? [{ type: 'text', text: first.content }] : blocks(first.content);
  const at = content.findIndex(block => block.type === 'text' && typeof block.text === 'string' && block.text.startsWith(BRIEF));
  const block = content[at];
  if (!block) return payload;
  const text = block.text as string, end = text.indexOf(RUN_MARK);
  if (end <= 0) return payload;
  const mark = marked(payload).find(item => record(item.cache_control))?.cache_control;
  if (!mark) return payload;
  // A second system block (the identity Pi adds for subscription tokens) needs no mark: the last one covers it.
  const system = blocks(payload.system);
  for (const item of system.slice(0, -1)) delete item.cache_control;
  if (marked(payload).length + 1 > MARKS) return payload;
  const head = { type: 'text', text: text.slice(0, end), cache_control: { ...(mark as Block) } };
  const tail = { ...block, text: text.slice(end) };
  first.content = [...content.slice(0, at), head, tail, ...content.slice(at + 1)];
  return payload;
}

/** The project's instruction files with the paths inside `directory` written relative to it: the prompt prints each path, and two worktrees of
 *  one repository hold the same file at different absolute paths, which made their system prompts differ from the first file on. */
export function relativeContext<T extends { path: string }>(files: readonly T[], directory: string): T[] {
  const root = directory.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
  return files.map(file => {
    const path = file.path.replaceAll('\\', '/');
    return path.toLowerCase().startsWith(`${root}/`) ? { ...file, path: path.slice(root.length + 1) } : file;
  });
}
