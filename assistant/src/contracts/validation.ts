export type Rule = (value: unknown) => boolean;
type Schema = { [key: string]: Rule | Schema };

export const text: Rule = value => typeof value === 'string' && value.isWellFormed() && value.trim().length > 0;
export const boundedText = (max: number): Rule => value => text(value) && (value as string).length <= max;
export const positive: Rule = value => Number.isSafeInteger(value) && (value as number) > 0;
export const timestamp: Rule = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value)) return false;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return false;
  const canonical = value.includes('.') ? value : value.replace('Z', '.000Z');
  return new Date(time).toISOString() === canonical;
};
export const oneOf = (...values: string[]): Rule => value => typeof value === 'string' && values.includes(value);
export const strings: Rule = value => Array.isArray(value) && value.every(text) && new Set(value).size === value.length;
export const version: Rule = value => value === 1;

export function optionalFields(value: unknown, rules: Record<string, Rule>): Record<string, Rule> {
  return Object.fromEntries(Object.entries(rules).filter(([key]) => value != null && Object.hasOwn(Object(value), key)));
}

export function object(value: unknown, schema: Schema, path = 'contract'): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`Expected object at ${path}`);
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(schema, key)) throw new TypeError(`Unknown field ${path}.${key}`);
  }
  for (const [key, rule] of Object.entries(schema)) {
    const field = `${path}.${key}`;
    if (!Object.hasOwn(input, key)) throw new TypeError(`Missing field ${field}`);
    if (typeof rule === 'function') {
      if (!rule(input[key])) throw new TypeError(`Invalid field ${field}`);
    } else {
      object(input[key], rule, field);
    }
  }
}
