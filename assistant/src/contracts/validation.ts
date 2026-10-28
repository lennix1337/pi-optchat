export type Rule = (value: unknown) => boolean;
export const text: Rule = value => typeof value === 'string' && value.trim().length > 0;
export const positive: Rule = value => Number.isSafeInteger(value) && (value as number) > 0;
export const timestamp: Rule = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value) && Number.isFinite(Date.parse(value));
export const oneOf = (...values: string[]): Rule => value => typeof value === 'string' && values.includes(value);
export const strings: Rule = value => Array.isArray(value) && value.every(text) && new Set(value).size === value.length;
export function object(value: unknown, schema: Record<string, Rule>): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Expected object');
  const input = value as Record<string, unknown>;
  const keys = Object.keys(input);
  if (keys.length !== Object.keys(schema).length || keys.some(key => !Object.hasOwn(schema, key)) || Object.entries(schema).some(([key, rule]) => !Object.hasOwn(input, key) || !rule(input[key]))) throw new TypeError('Invalid contract');
}
export const version: Rule = value => value === 1;
