/**
 * Persistence layer — JSON-faithful durable serialization.
 *
 * Durable envelopes must round-trip through JSON without silent alteration.
 * JSON.stringify silently drops `undefined`/function/symbol values, turns
 * `NaN`/`Infinity` into `null`, and already throws on cyclic graphs. The bus
 * semantics require a fail-before-mutate guarantee: if a value required for
 * durability cannot be serialized faithfully, the persistence boundary must
 * refuse BEFORE any row is written.
 *
 * This module is driver-neutral. Callers never see a JSON/SQLite type here.
 */

import { PersistenceError } from '../persistence-errors.mjs';

/**
 * Assert `value` is JSON-faithful: JSON.stringify(value) followed by
 * JSON.parse must reproduce the same value (NaN/Infinity/-0 excluded as
 * documented below). Throws a typed PersistenceError otherwise.
 * @param {unknown} value
 * @param {string} label - human label used in error context.
 * @returns {boolean} `true` when faithful.
 */
export function assertJsonFaithful(value, label = 'value') {
  walk(value, label, '$', new Set());
  return true;
}

function walk(value, label, path, seen) {
  if (value === null) return;
  const type = typeof value;
  if (type === 'undefined' || type === 'function' || type === 'symbol' || type === 'bigint') {
    throw new PersistenceError(`cannot durably persist ${label} at ${path}: ${type} cannot be stored faithfully`, {
      code: 'NOT_JSON_FAITHFUL',
      valueType: type,
      path,
    });
  }
  if (type === 'number') {
    if (!Number.isFinite(value)) {
      throw new PersistenceError(`cannot durably persist ${label} at ${path}: non-finite number ${String(value)}`, {
        code: 'NOT_JSON_FAITHFUL',
        valueType: 'number',
        path,
      });
    }
    return;
  }
  if (type !== 'object') return;
  if (value instanceof Date) {
    throw new PersistenceError(`cannot durably persist ${label} at ${path}: Date instances do not round-trip as their own type`, {
      code: 'NOT_JSON_FAITHFUL',
      valueType: 'Date',
      path,
    });
  }
  if (seen.has(value)) {
    throw new PersistenceError(`cannot durably persist ${label} at ${path}: cyclic reference is not serializable`, {
      code: 'NOT_JSON_FAITHFUL',
      valueType: 'cycle',
      path,
    });
  }
  seen.add(value);
  // Track only ancestors on the current recursion path. Sibling aliases
  // are JSON-safe DAGs: JSON.stringify duplicates their values faithfully.
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        walk(value[index], label, `${path}[${index}]`, seen);
      }
      return;
    }
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new PersistenceError(`cannot durably persist ${label} at ${path}: non-plain object (${proto?.constructor?.name ?? 'unknown'})`, {
        code: 'NOT_JSON_FAITHFUL',
        valueType: proto?.constructor?.name ?? 'non-plain',
        path,
      });
    }
    for (const key of Object.keys(value)) {
      walk(value[key], label, `${path}.${key}`, seen);
    }
  } finally {
    seen.delete(value);
  }
}

/**
 * Serialize a value to a durable JSON string. Fails before producing output
 * when the value is not JSON-faithful.
 * @param {unknown} value
 * @param {string} [label]
 * @returns {string}
 */
export function serializeDurable(value, label = 'value') {
  assertJsonFaithful(value, label);
  return JSON.stringify(value);
}

/**
 * Parse a durable JSON string back to its value.
 * @param {string} json
 * @param {string} [label]
 * @returns {unknown}
 * @throws {PersistenceError} with code `CORRUPT_DURABLE_STATE` on malformed input.
 */
export function parseDurable(json, label = 'value') {
  try {
    return JSON.parse(json);
  } catch (error) {
    throw new PersistenceError(`cannot parse stored ${label}: ${error instanceof Error ? error.message : String(error)}`, {
      code: 'CORRUPT_DURABLE_STATE',
      cause: error,
    });
  }
}
