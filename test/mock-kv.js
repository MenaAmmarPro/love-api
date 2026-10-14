"use strict";

/*
 * A tiny in-memory stand-in for a Workers KV namespace, good enough for the
 * unit tests. Mirrors the parts of the KV API that love-api uses.
 */

export class MockKV {
  constructor() {
    this.map = new Map();
  }

  async get(key, type) {
    const value = this.map.get(key);
    if (value === undefined) return null;
    if (type === "json") return JSON.parse(value);
    return value;
  }

  async put(key, value) {
    this.map.set(key, String(value));
  }

  async delete(key) {
    this.map.delete(key);
  }

  async list({ prefix = "", limit = 1000, cursor } = {}) {
    const all = [...this.map.keys()]
      .filter((key) => key.startsWith(prefix))
      .sort();
    const start = cursor ? all.indexOf(cursor) + 1 : 0;
    const slice = all.slice(start, start + limit);
    const list_complete = start + slice.length >= all.length;
    return {
      keys: slice.map((name) => ({ name })),
      list_complete,
      cursor: list_complete ? undefined : slice[slice.length - 1]
    };
  }
}
