import { AgenetesError } from '@agenetes/runtime';

/** Validate and copy host metadata without silently losing non-JSON values. */
export function copyHostMetadata(
  value: unknown,
  errorCode: 'invalid_host_metadata' | 'invalid_persisted_record',
): Record<string, unknown> {
  const invalid = (): never => {
    throw new AgenetesError(
      errorCode,
      'hostMetadata must be an object of JSON values',
    );
  };
  const ancestors = new Set<object>();
  const copy = (input: unknown): unknown => {
    if (
      input === null ||
      typeof input === 'string' ||
      typeof input === 'boolean' ||
      (typeof input === 'number' && Number.isFinite(input))
    ) {
      return input;
    }
    if (typeof input !== 'object' || input === null) return invalid();
    if (
      ancestors.has(input) ||
      Object.getOwnPropertySymbols(input).length > 0 ||
      (!Array.isArray(input) &&
        Object.getPrototypeOf(input) !== Object.prototype &&
        Object.getPrototypeOf(input) !== null)
    ) {
      return invalid();
    }
    ancestors.add(input);
    const result = Array.isArray(input)
      ? Array.from(input, copy)
      : Object.fromEntries(
          Object.entries(input).map(([key, entry]) => [key, copy(entry)]),
        );
    ancestors.delete(input);
    return result;
  };

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return invalid();
  }
  return copy(value) as Record<string, unknown>;
}
