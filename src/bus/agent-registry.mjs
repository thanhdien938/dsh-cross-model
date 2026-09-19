/**
 * Agent Bus Core — backend-neutral agent registry.
 *
 * The registry knows nothing about Codex, Claude, or Grok. A name is runtime
 * identity only; roles belong to tasks/workflows, never to a registered agent.
 */

import { DuplicateRegistrationError, InvalidAdapterError } from './errors.mjs';

export class AgentRegistry {
  #agents = new Map();

  /**
   * Register an adapter under a backend name.
   * @param {string} name - runtime identity (not a role).
   * @param {object} adapter - must implement `start({ task, run, signal })`.
   * @param {object} [metadata] - free-form descriptor (e.g. transport/provider/product).
   * @param {object} [options]
   * @param {boolean} [options.replace] - allow overwriting an existing registration.
   * @returns {this}
   */
  register(name, adapter, metadata = {}, { replace = false } = {}) {
    if (typeof name !== 'string' || name.trim() === '') {
      throw new InvalidAdapterError('agent name must be a non-empty string');
    }
    if (adapter === null || typeof adapter !== 'object' || typeof adapter.start !== 'function') {
      throw new InvalidAdapterError(`adapter for "${name}" must be an object with a start() method`);
    }
    if (!replace && this.#agents.has(name)) {
      throw new DuplicateRegistrationError(`agent already registered: "${name}" (pass { replace: true } to overwrite)`);
    }
    this.#agents.set(name, { name, adapter, metadata: metadata ?? {} });
    return this;
  }

  /** @returns {boolean} whether a backend is registered under `name`. */
  has(name) {
    return this.#agents.has(name);
  }

  /**
   * Get the adapter registered under `name`.
   * @returns {object|undefined}
   */
  get(name) {
    return this.#agents.get(name)?.adapter;
  }

  /** @returns {{ name: string, adapter: object, metadata: object }|undefined} */
  getEntry(name) {
    return this.#agents.get(name);
  }

  /** Remove a registration. @returns {boolean} whether it was present. */
  unregister(name) {
    return this.#agents.delete(name);
  }

  /** @returns {string[]} registered names in deterministic (sorted) order. */
  list() {
    return [...this.#agents.keys()].sort();
  }
}
