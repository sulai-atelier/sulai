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
