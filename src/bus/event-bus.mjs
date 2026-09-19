/**
 * Agent Bus Core — small synchronous in-process event bus.
 *
 * Emit is synchronous so lifecycle ordering is preserved exactly as produced.
 * A faulty listener must never corrupt core state: listener errors are
 * reported through the optional `onListenerError` hook (default `console.error`)
 * and emission continues.
 */

export class EventBus {
  #listeners = new Map();
  #wildcards = new Set();
  #onListenerError;

  /**
   * @param {object} [options]
   * @param {(error: unknown, event: string, payload: unknown) => void} [options.onListenerError]
   */
  constructor({ onListenerError } = {}) {
    this.#onListenerError = onListenerError ?? ((error, event) => {
      console.error(`event-bus: listener failed for "${event}": ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  /**
   * Subscribe to an event.
   * @param {string} event
   * @param {(payload: any) => void} handler
   * @returns {() => void} an unsubscribe function.
   */
  on(event, handler) {
    if (typeof event !== 'string' || event === '') throw new TypeError('event name must be a non-empty string');
    if (typeof handler !== 'function') throw new TypeError('handler must be a function');
    let set = this.#listeners.get(event);
    if (!set) {
      set = new Set();
      this.#listeners.set(event, set);
    }
    set.add(handler);
    return () => this.off(event, handler);
  }

  /** Subscribe for exactly one emission. */
  once(event, handler) {
    const wrapper = (payload) => {
      this.off(event, wrapper);
      return handler(payload);
    };
    this.on(event, wrapper);
    return () => this.off(event, wrapper);
  }

  /** Remove a specific handler for an event. */
  off(event, handler) {
    const set = this.#listeners.get(event);
    if (!set) return;
    set.delete(handler);
    if (set.size === 0) this.#listeners.delete(event);
  }

  /** Subscribe to every event (optional all-events subscription). */
  all(handler) {
    if (typeof handler !== 'function') throw new TypeError('handler must be a function');
    this.#wildcards.add(handler);
    return () => this.#wildcards.delete(handler);
  }

  /**
   * Emit an event synchronously. Specific listeners run before wildcard
   * listeners; all listeners run regardless of prior failures.
   * @param {string} event
   * @param {any} payload
   */
  emit(event, payload) {
    const set = this.#listeners.get(event);
    if (set) {
      for (const handler of [...set]) {
        try {
          handler(payload);
        } catch (error) {
          this.#onListenerError(error, event, payload);
        }
      }
    }
    if (this.#wildcards.size > 0) {
      for (const handler of [...this.#wildcards]) {
        try {
          handler(event, payload);
        } catch (error) {
          this.#onListenerError(error, event, payload);
        }
      }
    }
  }
}
