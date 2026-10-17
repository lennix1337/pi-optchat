import { Type } from 'typebox';

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
  spawn: Type.Object({ tasks: Type.Array(Type.Object({ task: Type.String(), cwd: Type.Optional(Type.String({ description: CWD_DOC })) }), { minItems: 1 }) }),
  tell: Type.Object({ id: Type.String(), message: Type.String() }),
  parent: Type.Object({ message: Type.String() }),
});
