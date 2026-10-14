"use strict";

/*
 * love-api — the wishes-wall backend for the Love for Mena sites.
 *
 * A tiny Cloudflare Worker over a KV namespace (binding: WISHES).
 *
 *   GET  /health   -> { ok, service }
 *   GET  /wishes   -> newest-first list  (?limit=1..100, ?cursor=)
 *   POST /wishes   -> { name, message, website(honeypot) } -> created wish
 *
 * Wishes are public and appear instantly, with a honeypot, a per-IP rate
 * limit, length caps and a light abuse guard to keep it kind and clean.
 */

import { createWish, listWishes } from "./store.js";

const SERVICE = "love-api";
const MAX_MSG = 280;
const MAX_NAME = 40;
const RATE_LIMIT = 5; // writes allowed per window
const RATE_WINDOW_MS = 60_000;

const ALLOWED_ORIGINS = [
  "https://menaammarpro.github.io",
  "https://www.menaammarpro.github.io"
];

// Very small abuse guard — lowercase substrings that never belong on the wall.
const BANNED = [
  "http://",
  "https://",
  "<script",
  "viagra",
  "casino",
  "porn",
  "xxx"
];

function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  return /^http:\/\/localhost(:\d+)?$/.test(origin) ||
    /^http:\/\/127\.0\.0\.1(:\d+)?$/.test(origin);
}

function corsHeaders(origin) {
  const allowed = isAllowedOrigin(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(origin)
    }
  });
}

function clean(text, max) {
  return String(text == null ? "" : text)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function containsBanned(text) {
  const lower = text.toLowerCase();
  return BANNED.some((word) => lower.includes(word));
}

async function ipHash(request) {
  const forwarded = (request.headers.get("x-forwarded-for") || "").split(",")[0].trim();
  const ip = request.headers.get("CF-Connecting-IP") || forwarded || "unknown";
  const data = new TextEncoder().encode(ip + "|love-api");
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

async function isRateLimited(env, request) {
  const bucket = Math.floor(Date.now() / RATE_WINDOW_MS);
  const key = "rl:" + (await ipHash(request)) + ":" + bucket;
  const current = parseInt((await env.WISHES.get(key)) || "0", 10) || 0;
  if (current >= RATE_LIMIT) return true;
  await env.WISHES.put(key, String(current + 1), {
    expirationTtl: Math.ceil(RATE_WINDOW_MS / 1000) * 2
  });
  return false;
}

async function handlePostWish(request, env, origin) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Expected a JSON body." }, 400, origin);
  }

  // Honeypot: bots love filling hidden fields. Pretend success, store nothing.
  if (clean(body.website, 200)) {
    return json({ ok: true, wish: null }, 201, origin);
  }

  const name = clean(body.name, MAX_NAME) || "Someone";
  const message = clean(body.message, MAX_MSG);

  if (!message) {
    return json({ ok: false, error: "Please write a little message." }, 422, origin);
  }
  if (containsBanned(message) || containsBanned(name)) {
    return json({ ok: false, error: "Please keep it kind and simple." }, 422, origin);
  }
  if (await isRateLimited(env, request)) {
    return json(
      { ok: false, error: "That's a lot at once \u2014 take a breath and try again in a minute." },
      429,
      origin
    );
  }

  const wish = await createWish(env, { name, message });
  return json({ ok: true, wish }, 201, origin);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    try {
      if (url.pathname === "/health" && request.method === "GET") {
        return json({ ok: true, service: SERVICE }, 200, origin);
      }

      if (url.pathname === "/wishes" && request.method === "GET") {
        const result = await listWishes(env, {
          limit: url.searchParams.get("limit"),
          cursor: url.searchParams.get("cursor") || undefined
        });
        return json(
          { ok: true, count: result.wishes.length, wishes: result.wishes, cursor: result.cursor },
          200,
          origin
        );
      }

      if (url.pathname === "/wishes" && request.method === "POST") {
        return await handlePostWish(request, env, origin);
      }

      return json({ ok: false, error: "Not found." }, 404, origin);
    } catch {
      return json({ ok: false, error: "Something went wrong." }, 500, origin);
    }
  }
};
