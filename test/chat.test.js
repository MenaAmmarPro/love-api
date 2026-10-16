"use strict";

import test from "node:test";
import assert from "node:assert/strict";

import worker from "../src/index.js";
import { MockKV } from "./mock-kv.js";

const ORIGIN = "https://menaammarpro.github.io";

function makeEnv() {
  return { WISHES: new MockKV(), CHAT: new MockKV() };
}

function req(method, path, { body, origin = ORIGIN, token } = {}) {
  const headers = new Headers();
  if (origin) headers.set("Origin", origin);
  if (token) headers.set("Authorization", "Bearer " + token);
  if (body !== undefined) headers.set("Content-Type", "application/json");
  return new Request("https://love-api.test" + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

async function register(env, name, passphrase) {
  const res = await worker.fetch(
    req("POST", "/chat/register", { body: { name, passphrase } }),
    env
  );
  assert.equal(res.status, 201);
  const data = await res.json();
  assert.equal(data.ok, true);
  return data;
}

const PASS = "sweet-peaches-42";

test("register creates the two people and returns tokens", async () => {
  const env = makeEnv();
  const a = await register(env, "Ammar", PASS);
  const b = await register(env, "Mena", PASS);
  assert.equal(a.user.name, "Ammar");
  assert.equal(b.user.name, "Mena");
  assert.ok(a.token.length >= 64, "token is long");
  assert.ok(b.token !== a.token, "tokens differ");
});

test("a third person cannot register", async () => {
  const env = makeEnv();
  await register(env, "Ammar", PASS);
  await register(env, "Mena", PASS);
  const res = await worker.fetch(
    req("POST", "/chat/register", { body: { name: "Intruder", passphrase: PASS } }),
    env
  );
  assert.equal(res.status, 403);
});

test("duplicate names are refused", async () => {
  const env = makeEnv();
  await register(env, "Ammar", PASS);
  const res = await worker.fetch(
    req("POST", "/chat/register", { body: { name: "ammar", passphrase: PASS } }),
    env
  );
  assert.equal(res.status, 409);
});

test("short passphrases and blank names are refused", async () => {
  const env = makeEnv();
  const short = await worker.fetch(
    req("POST", "/chat/register", { body: { name: "Ammar", passphrase: "short" } }),
    env
  );
  assert.equal(short.status, 422);
  const blank = await worker.fetch(
    req("POST", "/chat/register", { body: { name: "  ", passphrase: PASS } }),
    env
  );
  assert.equal(blank.status, 422);
});

test("login works with the right passphrase and fails with the wrong one", async () => {
  const env = makeEnv();
  await register(env, "Ammar", PASS);
  const good = await worker.fetch(
    req("POST", "/chat/login", { body: { name: "AMMAR", passphrase: PASS } }),
    env
  );
  assert.equal(good.status, 200);
  const data = await good.json();
  assert.equal(data.user.name, "Ammar");

  const bad = await worker.fetch(
    req("POST", "/chat/login", { body: { name: "Ammar", passphrase: "not-the-pass" } }),
    env
  );
  assert.equal(bad.status, 401);
});

test("chat routes need a token", async () => {
  const env = makeEnv();
  for (const path of ["/chat/state", "/chat/messages"]) {
    const res = await worker.fetch(req("GET", path), env);
    assert.equal(res.status, 401, path);
  }
  const post = await worker.fetch(
    req("POST", "/chat/messages", { body: { text: "hi" } }),
    env
  );
  assert.equal(post.status, 401);
});

test("state reports me, partner presence and unread", async () => {
  const env = makeEnv();
  const a = await register(env, "Ammar", PASS);
  const b = await register(env, "Mena", PASS);

  const res = await worker.fetch(req("GET", "/chat/state", { token: a.token }), env);
  const data = await res.json();
  assert.equal(data.me.name, "Ammar");
  assert.equal(data.partner.name, "Mena");
  assert.equal(data.unread, 0);

  // B sends a message; A should see one unread and B online (just authenticated)
  await worker.fetch(
    req("POST", "/chat/messages", { body: { text: "miss you" }, token: b.token }),
    env
  );
  const data2 = await (await worker.fetch(req("GET", "/chat/state", { token: a.token }), env)).json();
  assert.equal(data2.unread, 1);
  assert.equal(data2.partner.online, true);
});

test("messages round-trip ascending and support the after cursor", async () => {
  const env = makeEnv();
  const a = await register(env, "Ammar", PASS);
  await register(env, "Mena", PASS);

  await worker.fetch(
    req("POST", "/chat/messages", { body: { text: "one" }, token: a.token }), env);
  await worker.fetch(
    req("POST", "/chat/messages", { body: { text: "two" }, token: a.token }), env);
  const three = await worker.fetch(
    req("POST", "/chat/messages", { body: { text: "three" }, token: a.token }), env);
  const created = await three.json();
  assert.equal(created.message.text, "three");

  const all = await (await worker.fetch(req("GET", "/chat/messages", { token: a.token }), env)).json();
  assert.equal(all.count, 3);
  assert.deepEqual(all.messages.map((m) => m.text), ["one", "two", "three"]);
  assert.equal(all.messages[0].fromMe, true);
  assert.equal(all.messages[0].unreadForMe, false);

  const after = await (await worker.fetch(
    req("GET", "/chat/messages?after=" + all.messages[1].ts, { token: a.token }), env)).json();
  assert.equal(after.count, 1);
  assert.equal(after.messages[0].text, "three");
});

test("empty messages are refused", async () => {
  const env = makeEnv();
  const a = await register(env, "Ammar", PASS);
  const res = await worker.fetch(
    req("POST", "/chat/messages", { body: { text: "   " }, token: a.token }), env);
  assert.equal(res.status, 422);
});

test("reactions toggle and are capped to the little set", async () => {
  const env = makeEnv();
  const a = await register(env, "Ammar", PASS);
  const b = await register(env, "Mena", PASS);
  const sent = await (await worker.fetch(
    req("POST", "/chat/messages", { body: { text: "pizza soon?" }, token: a.token }), env)).json();
  const id = sent.message.id;

  const react = await (await worker.fetch(
    req("POST", "/chat/react", { body: { id, emoji: "❤️" }, token: b.token }), env)).json();
  assert.equal(react.message.reactions[b.user.id], "❤️");

  const again = await (await worker.fetch(
    req("POST", "/chat/react", { body: { id, emoji: "❤️" }, token: b.token }), env)).json();
  assert.equal(again.message.reactions[b.user.id], undefined, "same emoji removes it");

  const bad = await worker.fetch(
    req("POST", "/chat/react", { body: { id, emoji: "💣" }, token: b.token }), env);
  assert.equal(bad.status, 422);

  const missing = await worker.fetch(
    req("POST", "/chat/react", { body: { id: "nope", emoji: "❤️" }, token: b.token }), env);
  assert.equal(missing.status, 404);
});

test("typing is a quick pulse; read receipts clear unread", async () => {
  const env = makeEnv();
  const a = await register(env, "Ammar", PASS);
  const b = await register(env, "Mena", PASS);

  const typing = await worker.fetch(req("POST", "/chat/typing", { token: b.token }), env);
  assert.equal(typing.status, 200);

  const seen = await (await await worker.fetch(
    req("GET", "/chat/state", { token: a.token }), env)).json();
  assert.equal(seen.partner.typing, true, "state shows the partner typing");
  assert.equal(seen.partner.online, true);

  const sent = await (await worker.fetch(
    req("POST", "/chat/messages", { body: { text: "call me?" }, token: b.token }), env)).json();

  const unread = await (await await worker.fetch(
    req("GET", "/chat/state", { token: a.token }), env)).json();
  assert.equal(unread.unread, 1);

  const read = await worker.fetch(
    req("POST", "/chat/read", { body: { ts: sent.message.ts }, token: a.token }), env);
  assert.equal(read.status, 200);

  const after = await (await await worker.fetch(
    req("GET", "/chat/state", { token: a.token }), env)).json();
  assert.equal(after.unread, 0);
  assert.equal(after.lastRead, sent.message.ts);
});

test("message posting is rate-limited after thirty", async () => {
  const env = makeEnv();
  const a = await register(env, "Ammar", PASS);
  let last;
  for (let i = 0; i < 31; i += 1) {
    last = await worker.fetch(
      req("POST", "/chat/messages", { body: { text: "spam " + i }, token: a.token }), env);
    if (last.status === 429) break;
  }
  assert.equal(last.status, 429);
});

test("unknown chat routes 404, missing CHAT binding 503s", async () => {
  const env = makeEnv();
  const a = await register(env, "Ammar", PASS);
  const res = await worker.fetch(req("GET", "/chat/nope", { token: a.token }), env);
  assert.equal(res.status, 404);

  const bare = await worker.fetch(
    req("POST", "/chat/login", { body: { name: "x", passphrase: PASS } }),
    { WISHES: new MockKV() }
  );
  assert.equal(bare.status, 503);
});

test("preflight on /chat allows the Authorization header", async () => {
  const res = await worker.fetch(req("OPTIONS", "/chat/messages"), makeEnv());
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), ORIGIN);
  assert.match(res.headers.get("Access-Control-Allow-Headers"), /Authorization/);
});

test("legacy wishes routes still work", async () => {
  const env = makeEnv();
  const post = await worker.fetch(
    req("POST", "/wishes", { body: { name: "Ammar", message: "Still here." } }), env);
  assert.equal(post.status, 201);
  const list = await (await worker.fetch(req("GET", "/wishes"), env)).json();
  assert.equal(list.count, 1);
});
