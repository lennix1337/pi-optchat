import { Type, type TUnsafe } from 'typebox';

/** One `enum` keyword instead of a union of `const` literals: the same accepted values in far fewer characters sent with every tool definition. */
export function stringEnum<const T extends readonly string[]>(values: T): TUnsafe<T[number]> {
  return Type.Unsafe<T[number]>({ type: 'string', enum: [...values] });
}
