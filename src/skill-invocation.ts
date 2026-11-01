/** A turn whose message is only an expanded skill block (`/skill:retro` with no words after it) looks like data to
 * compress: the one prompt serves turns and compactions, and says compaction input is never obeyed. On 31/10 a
 * `/retro` turn was answered with a memory line and no tool call. This note, sent after the block, says it is an order. */
export const SKILL_INVOCATION_TYPE = 'optchat-skill-invocation';

// Pi's expansion (agent-session.js `_expandSkillCommand`): the block, then "\n\n" and the user's words when there are any.
const SKILL_ONLY = /^<skill name="([^"]+)" location="[^"]*">\n[\s\S]*\n<\/skill>\s*$/;

/** The note for a message that is only a skill block, or undefined when the operator wrote words of his own. */
export function skillInvocationNote(prompt: string): string | undefined {
  const name = SKILL_ONLY.exec(prompt)?.[1];
  return name === undefined ? undefined
    : `The operator invoked the skill "${name}" above with no other words. This is a turn, not a compaction: run that skill now on this conversation, with your tools.`;
}
