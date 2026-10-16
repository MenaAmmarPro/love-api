"use strict";

/*
 * love-api — the private chat ("WhatsApp for two") routes.
 *
 * One tiny Worker route family over a second KV namespace (binding: CHAT).
 * Exactly two people can register; everything else needs a Bearer token.
 *
 *   POST /chat/register  { name, passphrase }      -> { ok, user, token }
 *   POST /chat/login     { name, passphrase }      -> { ok, user, token }
 *   GET  /chat/state                               -> { me, partner, unread, lastRead }
 *   GET  /chat/messages  ?after=<ts>&limit=        -> { ok, messages }  (ascending)
 *   POST /chat/messages  { text }                  -> { ok, message }
 *   POST /chat/react     { id, emoji }             -> { ok, message }
 *   POST /chat/typing                              -> { ok }
 *   POST /chat/read      { ts }                    -> { ok }
 *
 * Design notes:
 *  - Passphrases are PBKDF2-SHA256 (100k iterations, per-user salt); the
 *    raw passphrase is never stored.
 *  - Tokens are 32 random bytes, stored only as their SHA-256 hash, with a
 *    30-day TTL, so KV itself expires old sessions.
 *  - Read receipts are a per-user `read:<id>` timestamp (no message rewrites).
 *  - "Online" = any authenticated call in the last minute (`seen:` key).
 */

import { invertTs, newId } from "./store.js";
import { json } from "./cors.js";

const MAX_TEXT = 2000;
const MAX_NAME = 40;
const MIN_PASS = 8;
const MSG_RATE = 30;          // messages per minute
const RATE_WINDOW_MS = 60_000;
const TOKEN_TTL_S = 30 * 24 * 3600;
const SEEN_TTL_S = 90;
const TYPING_TTL_S = 8;
const MAX_USERS = 2;
const EMOJIS = ["❤️", "🥰", "😂", "😢", "👍", "🔥", "☕", "✨"];
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

/* ---------- tiny helpers ---------- */

function clean(text, max) {
  return String(text == null ? "" : text)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function hex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function randHex(n) {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return hex(bytes);
}

function hexToBytes(s) {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return hex(new Uint8Array(digest));
}

async function hashPass(passphrase, salt) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: hexToBytes(salt), iterations: 100_000, hash: "SHA-256" },
    key,
    256
  );
  return hex(new Uint8Array(bits));
}

async function readBody(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

async function msgKey(ts, id) {
  return "msg:" + invertTs(ts) + ":" + id;
}

/* ---------- auth ---------- */

async function createUser(env, name, passphrase) {
  const salt = randHex(16);
  const hash = await hashPass(passphrase, salt);
  const user = { id: newId(), name, nameKey: name.toLowerCase(), salt, hash, createdAt: Date.now() };
  await env.CHAT.put("user:" + user.id, JSON.stringify(user));
  await env.CHAT.put("name:" + user.nameKey, user.id);
  return user;
}

async function findUser(env, nameKey) {
  const id = await env.CHAT.get("name:" + nameKey);
  if (!id) return null;
  return env.CHAT.get("user:" + id, "json");
}

async function listUsers(env) {
  const result = await env.CHAT.list({ prefix: "user:", limit: MAX_USERS });
  const users = [];
  for (const key of result.keys || []) {
    const user = await env.CHAT.get(key.name, "json");
    if (user) users.push(user);
  }
  return users;
}

async function issueToken(env, userId) {
  const token = randHex(32);
  const tokenHash = await sha256Hex(token);
  await env.CHAT.put("token:" + tokenHash, JSON.stringify({ userId, exp: Date.now() + TOKEN_TTL_S * 1000 }), {
    expirationTtl: TOKEN_TTL_S
  });
  return token;
}

async function auth(request, env) {
  const header = request.headers.get("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  const record = await env.CHAT.get("token:" + tokenHash, "json");
  if (!record || record.exp < Date.now()) return null;
  const user = await env.CHAT.get("user:" + record.userId, "json");
  if (!user) return null;
  await env.CHAT.put("seen:" + user.id, String(Date.now()), { expirationTtl: SEEN_TTL_S });
  return { user, tokenHash };
}

async function rateLimited(env, bucketId) {
  const bucket = Math.floor(Date.now() / RATE_WINDOW_MS);
  const key = "rl:" + bucketId + ":" + bucket;
  const current = parseInt((await env.CHAT.get(key)) || "0", 10) || 0;
  if (current >= MSG_RATE) return true;
  await env.CHAT.put(key, String(current + 1), {
    expirationTtl: Math.ceil(RATE_WINDOW_MS / 1000) * 2
  });
  return false;
}

/* ---------- messages ---------- */

async function createMessage(env, user, text) {
  const ts = Date.now();
  const id = newId();
  const message = { id, from: user.id, fromName: user.name, text, ts, reactions: {} };
  await env.CHAT.put(await msgKey(ts, id), JSON.stringify(message));
  await env.CHAT.put("msgid:" + id, await msgKey(ts, id));
  return message;
}

async function getMessage(env, id) {
  const key = await env.CHAT.get("msgid:" + id);
  if (!key) return null;
  const message = await env.CHAT.get(key, "json");
  return message ? { key, message } : null;
}

async function listMessages(env, { after = 0, limit = DEFAULT_LIMIT } = {}) {
  const capped = Math.max(1, Math.min(Number(limit) || DEFAULT_LIMIT, MAX_LIMIT));
  // Walk newest-first; keep only messages newer than `after`, up to `capped`
  // of the most recent ones; then flip to ascending for the client.
  const found = [];
  let cursor;
  for (;;) {
    const page = await env.CHAT.list({ prefix: "msg:", limit: 100, cursor });
    for (const key of (page.keys || []).reverse()) {
      const message = await env.CHAT.get(key.name, "json");
      if (message && message.ts > after) {
        found.push(message);
        if (found.length >= capped) break;
      }
    }
    if (found.length >= capped || page.list_complete) break;
    cursor = page.cursor;
  }
  found.sort((a, b) => a.ts - b.ts);
  return found;
}

async function unreadCount(env, meId) {
  const lastRead = Number(await env.CHAT.get("read:" + meId)) || 0;
  const recent = await listMessages(env, { after: lastRead, limit: MAX_LIMIT });
  return recent.filter((m) => m.from !== meId).length;
}

/* ---------- handlers ---------- */

async function handleRegister(request, env, origin) {
  const body = await readBody(request);
  if (!body) return json({ ok: false, error: "Expected a JSON body." }, 400, origin);
  const name = clean(body.name, MAX_NAME);
  const passphrase = String(body.passphrase || "");
  if (!name) return json({ ok: false, error: "Please pick a name." }, 422, origin);
  if (passphrase.length < MIN_PASS) {
    return json({ ok: false, error: "A passphrase of at least " + MIN_PASS + " characters, please." }, 422, origin);
  }
  const existing = await listUsers(env);
  if (existing.length >= MAX_USERS) {
    return json({ ok: false, error: "This little chat already has its two people." }, 403, origin);
  }
  if (existing.some((u) => u.nameKey === name.toLowerCase())) {
    return json({ ok: false, error: "That name is taken." }, 409, origin);
  }
  const user = await createUser(env, name, passphrase);
  const token = await issueToken(env, user.id);
  return json({ ok: true, user: { id: user.id, name: user.name }, token }, 201, origin);
}

async function handleLogin(request, env, origin) {
  const body = await readBody(request);
  if (!body) return json({ ok: false, error: "Expected a JSON body." }, 400, origin);
  const name = clean(body.name, MAX_NAME).toLowerCase();
  const user = await findUser(env, name);
  const badCreds = json({ ok: false, error: "Wrong name or passphrase." }, 401, origin);
  if (!user) return badCreds;
  const hash = await hashPass(String(body.passphrase || ""), user.salt);
  if (hash !== user.hash) return badCreds;
  const token = await issueToken(env, user.id);
  return json({ ok: true, user: { id: user.id, name: user.name }, token }, 200, origin);
}

async function handleState(request, env, origin, session) {
  const users = await listUsers(env);
  const partner = users.find((u) => u.id !== session.user.id);
  let partnerOnline = false;
  if (partner) {
    partnerOnline = Boolean(
      (await env.CHAT.get("seen:" + partner.id)) || (await env.CHAT.get("typing:" + partner.id))
    );
  }
  return json({
    ok: true,
    me: { id: session.user.id, name: session.user.name },
    partner: partner ? { id: partner.id, name: partner.name, online: partnerOnline } : null,
    unread: await unreadCount(env, session.user.id),
    lastRead: Number(await env.CHAT.get("read:" + session.user.id)) || 0
  }, 200, origin);
}

async function handleGetMessages(request, env, origin, session, url) {
  const messages = await listMessages(env, {
    after: Number(url.searchParams.get("after")) || 0,
    limit: url.searchParams.get("limit") || DEFAULT_LIMIT
  });
  const lastRead = Number(await env.CHAT.get("read:" + session.user.id)) || 0;
  return json({
    ok: true,
    count: messages.length,
    messages: messages.map((m) => ({
      ...m,
      fromMe: m.from === session.user.id,
      unreadForMe: m.from !== session.user.id && m.ts > lastRead
    }))
  }, 200, origin);
}

async function handlePostMessage(request, env, origin, session) {
  const body = await readBody(request);
  const text = clean(body && body.text, MAX_TEXT);
  if (!text) return json({ ok: false, error: "Say something first." }, 422, origin);
  if (await rateLimited(env, "msg:" + session.tokenHash)) {
    return json({ ok: false, error: "Too fast \u2014 a breath, then try again." }, 429, origin);
  }
  const message = await createMessage(env, session.user, text);
  return json({ ok: true, message: { ...message, fromMe: true, unreadForMe: false } }, 201, origin);
}

async function handleReact(request, env, origin, session) {
  const body = await readBody(request);
  const emoji = String((body && body.emoji) || "");
  if (!EMOJIS.includes(emoji)) {
    return json({ ok: false, error: "Pick one of the little reactions." }, 422, origin);
  }
  const found = await getMessage(env, String((body && body.id) || ""));
  if (!found) return json({ ok: false, error: "That message is gone." }, 404, origin);
  const message = found.message;
  if (message.reactions[session.user.id] === emoji) {
    delete message.reactions[session.user.id]; // same emoji again = take it back
  } else {
    message.reactions[session.user.id] = emoji;
  }
  await env.CHAT.put(found.key, JSON.stringify(message));
  return json({
    ok: true,
    message: { ...message, fromMe: message.from === session.user.id, unreadForMe: false }
  }, 200, origin);
}

async function handleTyping(request, env, origin, session) {
  await env.CHAT.put("typing:" + session.user.id, String(Date.now()), {
    expirationTtl: TYPING_TTL_S
  });
  return json({ ok: true }, 200, origin);
}

async function handleRead(request, env, origin, session) {
  const body = await readBody(request);
  const ts = Number(body && body.ts);
  if (!Number.isFinite(ts) || ts <= 0) return json({ ok: false, error: "Missing timestamp." }, 422, origin);
  await env.CHAT.put("read:" + session.user.id, String(ts));
  return json({ ok: true }, 200, origin);
}

/* ---------- entry ---------- */

export async function handleChat(request, env, origin, url) {
  if (!env.CHAT) {
    return json({ ok: false, error: "Chat is not configured yet." }, 503, origin);
  }
  const path = url.pathname;
  const method = request.method;

  if (path === "/chat/register" && method === "POST") return handleRegister(request, env, origin);
  if (path === "/chat/login" && method === "POST") return handleLogin(request, env, origin);

  const session = await auth(request, env);
  if (!session) return json({ ok: false, error: "Sign in first." }, 401, origin);

  if (path === "/chat/state" && method === "GET") return handleState(request, env, origin, session);
  if (path === "/chat/messages" && method === "GET") return handleGetMessages(request, env, origin, session, url);
  if (path === "/chat/messages" && method === "POST") return handlePostMessage(request, env, origin, session);
  if (path === "/chat/react" && method === "POST") return handleReact(request, env, origin, session);
  if (path === "/chat/typing" && method === "POST") return handleTyping(request, env, origin, session);
  if (path === "/chat/read" && method === "POST") return handleRead(request, env, origin, session);

  return json({ ok: false, error: "Not found." }, 404, origin);
}
