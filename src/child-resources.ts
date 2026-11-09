import { Type } from 'typebox';
import { stringEnum } from './string-enum.ts';
import { WORKER_KINDS } from './crew.ts';

export const CWD_DOC = 'Project directory the subagent works in (~ allowed); its AGENTS.md files load from there. Defaults to your current directory.';

const freezeTree = <T>(value: T): T => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) freezeTree(Reflect.get(value, key));
    Object.freeze(value);
  }
  return value;
};

/** Static tool schemas are shared; each child still gets fresh tools and session-bound closures. */
export const childToolSchemas = freezeTree({
  spawn: Type.Object({ tasks: Type.Array(Type.Object({ task: Type.String(), cwd: Type.Optional(Type.String({ description: CWD_DOC })),
    kind: Type.Optional(stringEnum(WORKER_KINDS, { description: 'Manager mode worker: code (Sonnet), mechanical (Haiku), hard (Opus), plan (read-only scout). The task must then be a contract.' })),
    project: Type.Optional(Type.String({ description: 'Specialist slug (lowercase letters, digits, hyphens) whose charter and memory brief the worker; default from cwd. A new slug starts a new specialist.' })) }, { additionalProperties: false }), { minItems: 1 }) }, { additionalProperties: false }),
  tell: Type.Object({ id: Type.String(), message: Type.String() }, { additionalProperties: false }),
  parent: Type.Object({ message: Type.String() }, { additionalProperties: false }),
});
