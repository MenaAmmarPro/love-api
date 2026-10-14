"use strict";

import test from "node:test";
import assert from "node:assert/strict";

import worker from "../src/index.js";
import { wishKey } from "../src/store.js";
import { MockKV } from "./mock-kv.js";

const ORIGIN = "https://menaammarpro.github.io";

function makeEnv() {
  return { WISHES: new MockKV() };
}

function req(method, path, { body, origin = ORIGIN, ip = "1.2.3.4" } = {}) {
  const headers = new Headers();
  if (origin) headers.set("Origin", origin);
  if (ip) headers.set("CF-Connecting-IP", ip);
  if (body !== undefined) headers.set("Content-Type", "application/json");
  return new Request("https://love-api.test" + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

test("GET /health reports the service is up", async () => {
  const res = await worker.fetch(req("GET", "/health"), makeEnv());
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.service, "love-api");
});

test("POST /wishes stores a wish and GET returns it", async () => {
  const env = makeEnv();
  const post = await worker.fetch(
    req("POST", "/wishes", { body: { name: "Ammar", message: "For you, always." } }),
    env
  );
  assert.equal(post.status, 201);
  const created = await post.json();
  assert.equal(created.ok, true);
  assert.equal(created.wish.name, "Ammar");
  assert.equal(created.wish.message, "For you, always.");

  const list = await worker.fetch(req("GET", "/wishes"), env);
  assert.equal(list.status, 200);
  const data = await list.json();
  assert.equal(data.count, 1);
  assert.equal(data.wishes[0].message, "For you, always.");
});

test("POST /wishes rejects an empty message", async () => {
  const res = await worker.fetch(
    req("POST", "/wishes", { body: { name: "Ammar", message: "   " } }),
    makeEnv()
  );
  assert.equal(res.status, 422);
  const data = await res.json();
  assert.equal(data.ok, false);
});

test("POST /wishes silently drops a filled honeypot", async () => {
  const env = makeEnv();
  const res = await worker.fetch(
    req("POST", "/wishes", { body: { message: "spam", website: "http://bot.example" } }),
    env
  );
  assert.equal(res.status, 201);
  const data = await res.json();
  assert.equal(data.wish, null);

  const list = await worker.fetch(req("GET", "/wishes"), env);
  const data2 = await list.json();
  assert.equal(data2.count, 0);
});

test("POST /wishes blocks banned content", async () => {
  const res = await worker.fetch(
    req("POST", "/wishes", { body: { message: "buy now at <script>" } }),
    makeEnv()
  );
  assert.equal(res.status, 422);
});

test("POST /wishes rate-limits after five writes in a window", async () => {
  const env = makeEnv();
  for (let i = 0; i < 5; i += 1) {
    const res = await worker.fetch(
      req("POST", "/wishes", { body: { message: "wish " + i } }),
      env
    );
    assert.equal(res.status, 201);
  }
  const blocked = await worker.fetch(
    req("POST", "/wishes", { body: { message: "one too many" } }),
    env
  );
  assert.equal(blocked.status, 429);
});

test("GET /wishes returns newest first", async () => {
  const env = makeEnv();
  await env.WISHES.put(wishKey(1000, "a"), JSON.stringify({ id: "a", name: "x", message: "old", ts: 1000 }));
  await env.WISHES.put(wishKey(3000, "c"), JSON.stringify({ id: "c", name: "x", message: "new", ts: 3000 }));
  await env.WISHES.put(wishKey(2000, "b"), JSON.stringify({ id: "b", name: "x", message: "mid", ts: 2000 }));

  const res = await worker.fetch(req("GET", "/wishes"), env);
  const data = await res.json();
  assert.deepEqual(data.wishes.map((w) => w.message), ["new", "mid", "old"]);
});

test("OPTIONS preflight echoes an allowed origin", async () => {
  const res = await worker.fetch(req("OPTIONS", "/wishes"), makeEnv());
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), ORIGIN);
});

test("CORS falls back to the primary origin for unknown origins", async () => {
  const res = await worker.fetch(
    req("GET", "/health", { origin: "https://evil.example" }),
    makeEnv()
  );
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), ORIGIN);
});

test("unknown routes return 404", async () => {
  const res = await worker.fetch(req("GET", "/nope"), makeEnv());
  assert.equal(res.status, 404);
});
