/**
 * A type that represents a type with all properties of `T` but with `undefined`
 * values. This is more useful than `Partial<T>` because it allows you to
 * specify properties that are not optional, and it enforces that all properties
 * are provided (even if they are `undefined`).
 */
export type PartiallyUndefined<T> = {
  [P in keyof T]: T[P] | undefined
}
