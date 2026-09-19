export class CoordinationError extends Error {
  constructor(message, { code = 'COORDINATION_ERROR', cause, ...details } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'CoordinationError';
    this.code = code;
    Object.assign(this, details);
  }
}

