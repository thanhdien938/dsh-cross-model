/**
 * Agent Bus Core error types and capability markers.
 *
 * All errors are serializable: stored state must never hold raw `Error`
 * instances, only the sanitized form produced by {@link toSanitizedError}.
 */

/** Marker returned by adapters that cannot perform an optional capability. */
export const UNSUPPORTED = Symbol('UNSUPPORTED');

/**
 * Base error for the agent bus core. Carries a stable machine-readable `code`
 * so callers and the evidence layer can branch without string matching.
 */
export class BusError extends Error {
  constructor(message, { code = 'BUS_ERROR', cause } = {}) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = 'BusError';
    this.code = code;
  }
}

export class InvalidEnvelopeError extends BusError {
  constructor(message, extra = {}) {
    super(message, { code: 'INVALID_ENVELOPE' });
    Object.assign(this, extra);
  }
}

export class InvalidAdapterError extends BusError {
  constructor(message) {
    super(message, { code: 'INVALID_ADAPTER' });
  }
}

export class DuplicateRegistrationError extends BusError {
  constructor(message) {
    super(message, { code: 'DUPLICATE_REGISTRATION' });
  }
}

export class AgentNotRegisteredError extends BusError {
  constructor(message) {
    super(message, { code: 'AGENT_NOT_REGISTERED' });
  }
}

export class UnknownTaskError extends BusError {
  constructor(message) {
    super(message, { code: 'UNKNOWN_TASK' });
  }
}

export class UnknownRunError extends BusError {
  constructor(message) {
    super(message, { code: 'UNKNOWN_RUN' });
  }
}

export class UnsupportedCapabilityError extends BusError {
  constructor(message, extra = {}) {
    super(message, { code: 'UNSUPPORTED_CAPABILITY' });
    Object.assign(this, extra);
  }
}

/**
 * Reduce any thrown value to a plain serializable object for state storage.
 * @param {unknown} error - the thrown value to sanitize.
 * @returns {{ name: string, message: string, code?: string }}
 */
export function toSanitizedError(error) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error.code !== undefined ? { code: String(error.code) } : {}),
    };
  }
  if (error !== null && typeof error === 'object' && !Array.isArray(error)) {
    return {
      name: typeof error.name === 'string' ? error.name : 'Error',
      message: typeof error.message === 'string' ? error.message : String(error),
      ...(error.code !== undefined ? { code: String(error.code) } : {}),
    };
  }
  return { name: 'Error', message: String(error) };
}
