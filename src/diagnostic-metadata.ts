// Shared boundary validators for the metadata-only usage and incident ledgers.
export const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
export const safeIdentifier = (value: unknown, max = 128): value is string => typeof value === 'string'
  && value.length <= max && /^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/.test(value)
  && !/(?:sk|rk|pk)-(?:ant|proj|live)?|api[_-]?key|bearer|password|secret|token/i.test(value);
