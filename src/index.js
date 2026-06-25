import { BingoRoom } from "./bingo-room.js";

export { BingoRoom };

// HMAC a fixed message with the site password as the key. The resulting token
// is handed to clients that prove they know the password, and required on the
// WebSocket connection. Because it's derived from the password, changing the
// password invalidates every existing token.
async function makeToken(env) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(env.SITE_PASSWORD || ""),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode("meeting-bingo-authed-v1"));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // --- Login: exchange the shared password for a token ---
    if (url.pathname === "/api/login" && request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: "bad request" }, 400);
      }
      const supplied = String(body?.password ?? "");
      const expected = String(env.SITE_PASSWORD ?? "");
      if (expected.length > 0 && timingSafeEqual(supplied, expected)) {
        return json({ ok: true, token: await makeToken(env) });
      }
      return json({ ok: false, error: "wrong password" }, 401);
    }

    // --- WebSocket: real-time game, gated by token ---
    if (url.pathname === "/ws") {
      const token = url.searchParams.get("token") || "";
      const expected = await makeToken(env);
      if (!timingSafeEqual(token, expected)) {
        return new Response("unauthorized", { status: 401 });
      }
      // One shared room for the whole site.
      const id = env.BINGO_ROOM.idFromName("global");
      const stub = env.BINGO_ROOM.get(id);
      return stub.fetch(request);
    }

    // --- Everything else: static assets (index.html, app.js, styles.css) ---
    return env.ASSETS.fetch(request);
  },
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}
