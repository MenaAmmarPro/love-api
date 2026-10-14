"use strict";

/*
 * love-api — KV storage helpers for the wishes wall.
 *
 * Each wish is stored under `wish:<inverted-ts>:<id>` so that KV's
 * lexicographic key order returns the newest wishes first.
 */

const PREFIX = "wish:";
const TS_PAD = 13;
const TS_MAX = 9_999_999_999_999;

export function invertTs(ts) {
  return String(TS_MAX - ts).padStart(TS_PAD, "0");
}

export function wishKey(ts, id) {
  return PREFIX + invertTs(ts) + ":" + id;
}

export function newId() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function createWish(env, { name, message }) {
  const ts = Date.now();
  const id = newId();
  const wish = { id, name, message, ts };
  await env.WISHES.put(wishKey(ts, id), JSON.stringify(wish));
  return wish;
}

export async function listWishes(env, { limit = 50, cursor } = {}) {
  const capped = Math.max(1, Math.min(Number(limit) || 50, 100));
  const result = await env.WISHES.list({ prefix: PREFIX, limit: capped, cursor });
  const keys = result.keys || [];
  const wishes = [];
  for (const key of keys) {
    const wish = await env.WISHES.get(key.name, "json");
    if (wish) wishes.push(wish);
  }
  return {
    wishes,
    cursor: result.list_complete ? null : result.cursor || null
  };
}
