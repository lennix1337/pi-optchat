import { Type } from 'typebox';
import { stringEnum } from './string-enum.ts';
import { WORKER_KINDS } from './crew.ts';
import { PAGE } from './memory.ts';
import { FIND } from './zoom-navigation.ts';

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
    kind: Type.Optional(stringEnum(WORKER_KINDS, { description: 'Manager mode worker: code (mid tier), mechanical (small), hard (top), plan (read-only scout, top). Its model is that tier in your own provider family and account, unless `model` is given. The task must then be a contract.' })),
    model: Type.Optional(Type.String({ description: 'Explicit model as provider/model, e.g. anthropic-account-2/claude-sonnet-5-5 or openai-codex-account-2/gpt-6.1-terra. Overrides the kind\'s tier and may use any account or provider; one that does not exist fails the spawn instead of being replaced. Omit it to spend your own quota.' })),
    project: Type.Optional(Type.String({ description: 'Specialist slug (lowercase letters, digits, hyphens) whose charter and memory brief the worker; default from cwd. A new slug starts a new specialist.' })),
    peer: Type.Optional(Type.String({ minLength: 1, description: 'Pairs this contract worker with an existing one of the same project (the reviewer names its author\'s run id): both get tell_peer to message each other, at most 6 messages per pair, and you get a copy of each. Information only, never orders.' })) }, { additionalProperties: false }), { minItems: 1 }) }, { additionalProperties: false }),
  tell: Type.Object({ id: Type.String(), message: Type.String() }, { additionalProperties: false }),
  retarget: Type.Object({ id: Type.String(), message: Type.String(), model: Type.Optional(Type.String({ description: 'Exact provider/model; omitted preserves the saved model.' })), thinking: Type.Optional(stringEnum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const, { description: 'Omitted preserves the saved thinking level.' })) }, { additionalProperties: false }),
  parent: Type.Object({ message: Type.String() }, { additionalProperties: false }),
  peer: Type.Object({ message: Type.String() }, { additionalProperties: false }),
  specialistMemory: Type.Object({ id: Type.Optional(Type.Integer({ minimum: 0 })), n: Type.Optional(Type.Integer({ minimum: 1 })),
    findText: Type.Optional(Type.String({ minLength: 1, maxLength: FIND.maxText })), offset: Type.Optional(Type.Integer({ minimum: 0 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: PAGE })), run: Type.Optional(Type.String({ minLength: 1, description: 'A run id of your own project: opens its transcript.' })) }, { additionalProperties: false }),
});
