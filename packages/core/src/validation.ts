export class ValidationError extends Error {
  override readonly name = 'ValidationError';
}

export function record(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ValidationError(`${label} must be an object`);
  }
  const actual = Object.keys(value);
  if (
    actual.length !== keys.length ||
    !keys.every((key) => Object.hasOwn(value, key))
  ) {
    throw new ValidationError(`${label} has missing or unknown fields`);
  }
  return value as Record<string, unknown>;
}

export function byteRange(
  start: unknown,
  end: unknown,
  lower: number,
  upper: number,
): { startByte: number; endByte: number } {
  if (
    typeof start !== 'number' ||
    typeof end !== 'number' ||
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < lower ||
    end > upper ||
    start >= end
  ) {
    throw new ValidationError('Expected a nonempty, in-bounds byte range');
  }
  return { startByte: start, endByte: end };
}

export function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new ValidationError(`${label} must be an array`);
  }
  return value;
}

export function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.isWellFormed()) {
    throw new ValidationError(`${label} must be a well-formed string`);
  }
  return value;
}

export function timestamp(value: unknown, label: string): string {
  const input = text(value, label);
  const parsed = new Date(input);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== input) {
    throw new ValidationError(`${label} must be an ISO 8601 UTC timestamp`);
  }
  return input;
}

export function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): T {
  if (
    typeof value !== 'string' ||
    !(allowed as readonly string[]).includes(value)
  ) {
    throw new ValidationError(`${label} is not a recognized value`);
  }
  return value as T;
}
