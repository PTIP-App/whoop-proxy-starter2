// server.js — WHOOP proxy (beginner-friendly, single-user)
// Works with: Node 18+, Express 4, node-fetch 3, express-session

import express from "express";
import fetch from "node-fetch";
import session from "express-session";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ───────────────────────────────────────────────────────────────────────────────
// ENV (Render → Settings → Environment Variables)
// Make sure WHOOP_CLIENT_ID, WHOOP_CLIENT_SECRET, SESSION_SECRET are set in Render.
// BASE_URL should be your public URL (no trailing slash), e.g.
//   https://whoop-proxy.onrender.com
// We'll default to your chosen domain to keep things simple.
const {
  WHOOP_CLIENT_ID,
  WHOOP_CLIENT_SECRET,
  BASE_URL = "https://whoop-proxy.onrender.com",
  SESSION_SECRET = "change-this-session-secret"
} = process.env;

if (!WHOOP_CLIENT_ID || !WHOOP_CLIENT_SECRET) {
  console.warn("⚠️ Missing WHOOP_CLIENT_ID or WHOOP_CLIENT_SECRET env vars.");
}

// WHOOP OAuth + API endpoints (v2)
const WHOOP_AUTH = "https://api.prod.whoop.com/oauth/oauth2/auth";
const WHOOP_TOKEN = "https://api.prod.whoop.com/oauth/oauth2/token";

// Single-user token storage fallback (so GPT calls work without browser cookies).
// NOTE: Tokens will be lost if the service restarts. If you want persistence,
// later we can add Redis; for now this keeps things simple.
let globalTokens = null;

// ───────────────────────────────────────────────────────────────────────────────
// App setup
const app = express();
app.use(express.json());
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: true
  })
);
app.use("/public", express.static(path.join(__dirname, "public")));

// Simple home page with a connect button
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public/index.html"));
});

// Serve your OpenAPI file for GPT Actions
app.get("/openapi.json", (_req, res) => {
  res.sendFile(path.join(__dirname, "openapi.json"));
});

// ───────────────────────────────────────────────────────────────────────────────
// OAuth: Start WHOOP connect flow
app.get("/connect/whoop", (req, res) => {
  const scope = encodeURIComponent(
    "read:profile read:body_measurement read:cycles read:recovery read:sleep read:workout offline"
  );
  const state = Math.random().toString(36).slice(2, 10); // tiny CSRF token
  req.session.oauth_state = state;

  const url =
    `${WHOOP_AUTH}?response_type=code` +
    `&client_id=${encodeURIComponent(WHOOP_CLIENT_ID)}` +
    `&redirect_uri=${encodeURIComponent(`${BASE_URL}/oauth/callback`)}` +
    `&scope=${scope}` +
    `&state=${state}`;

  res.redirect(url);
});

// OAuth: Callback → exchange code for tokens
app.get("/oauth/callback", async (req, res) => {
  try {
    const { code, state } = req.query;

    if (!code) return res.status(400).send("Missing code");
    if (state !== req.session.oauth_state) {
      return res.status(400).send("Bad state");
    }

    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: `${BASE_URL}/oauth/callback`,
      client_id: WHOOP_CLIENT_ID,
      client_secret: WHOOP_CLIENT_SECRET
    });

    const r = await fetch(WHOOP_TOKEN, { method: "POST", body });
    if (!r.ok) {
      const text = await r.text();
      return res.status(500).send(`Token exchange failed: ${r.status} ${text}`);
    }
    const tokens = await r.json(); // { access_token, refresh_token, expires_in, ... }

    // Save to session (for browser) and to global (for GPT/server-to-server)
    req.session.tokens = tokens;
    globalTokens = tokens;

    res.send("✅ WHOOP connected. You can close this tab.");
  } catch (err) {
    res.status(500).send(`OAuth error: ${err.message}`);
  }
});

// ───────────────────────────────────────────────────────────────────────────────
// Token helpers + WHOOP fetch

async function refreshTokens(tokens) {
  if (!tokens?.refresh_token) throw new Error("Missing refresh token");
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: tokens.refresh_token,
    client_id: WHOOP_CLIENT_ID,
    client_secret: WHOOP_CLIENT_SECRET,
    scope: "offline"
  });
  const r = await fetch(WHOOP_TOKEN, { method: "POST", body });
  if (!r.ok) throw new Error(`Refresh failed ${r.status}`);
  return r.json();
}

// Fetch a WHOOP URL with auth, handle a single refresh on 401
async function whoopGet(req, url) {
  // Prefer session tokens, fallback to global
  let tokens = req.session?.tokens || globalTokens;
  if (!tokens?.access_token) {
    throw new Error("Not connected to WHOOP yet. Visit /connect/whoop");
  }

  const doFetch = (accessToken) =>
    fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });

  let r = await doFetch(tokens.access_token);

  // If unauthorized, try refreshing once
  if (r.status === 401) {
    const newTokens = await refreshTokens(tokens);
    // Save back into both places
    if (req.session) req.session.tokens = newTokens;
    globalTokens = newTokens;
    r = await doFetch(newTokens.access_token);
  }

  if (!r.ok) {
    const text = await r.text();
    throw new Error(`WHOOP error ${r.status}: ${text}`);
  }
  return r.json();
}

// ───────────────────────────────────────────────────────────────────────────────
// Small JSON helpers (keep GPT payloads tiny)

function rangeUrl(base, { start, end, limit, nextToken }) {
  const p = new URLSearchParams();
  if (start) p.set("start", start);
  if (end) p.set("end", end);
  if (limit) p.set("limit", String(limit));
  if (nextToken) p.set("nextToken", nextToken);
  return `${base}?${p.toString()}`;
}

function trimRecord(rec) {
  // Keep compact, commonly useful fields if available
  const keep = {};
  for (const k of [
    "id",
    "start",
    "end",
    "createdAt",
    "updatedAt",
    "date",
    "score",
    "sleep_score",
    "recovery_score",
    "strain",
    "sport",
    "duration",
    "kilojoules",
    "calories",
    "resting_heart_rate",
    "heart_rate_variability_rmssd",
    "sleep_efficiency"
  ]) {
    if (rec && rec[k] !== undefined) keep[k] = rec[k];
  }
  return Object.keys(keep).length ? keep : rec;
}

function maybeTrim(arr, trim) {
  if (!trim) return arr;
  return arr.map(trimRecord);
}

async function fetchPage(req, base, args) {
  const url = rangeUrl(base, args);
  const page = await whoopGet(req, url);
  return {
    records: Array.isArray(page.records) ? page.records : [],
    nextToken: page.nextToken || page.next_token || null
  };
}

// ───────────────────────────────────────────────────────────────────────────────
// Convenience routes

// Tiny today endpoint (fast to test)
app.get("/today/recovery", async (req, res) => {
  try {
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const end = new Date(); end.setHours(23, 59, 59, 999);
    const url = rangeUrl("https://api.prod.whoop.com/developer/v2/recovery", {
      start: start.toISOString(),
      end: end.toISOString(),
      limit: 1
    });
    const data = await whoopGet(req, url);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 30-day convenience bundle (can be large; prefer /list/* in GPT)
app.get("/me/summary", async (req, res) => {
  try {
    const now = new Date().toISOString();
    const start = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    const [profile, body, cycles, recovery, sleep] = await Promise.all([
      whoopGet(req, "https://api.prod.whoop.com/developer/v2/user/profile/basic"),
      whoopGet(req, "https://api.prod.whoop.com/developer/v2/user/measurement/body"),
      whoopGet(req, rangeUrl("https://api.prod.whoop.com/developer/v2/cycle", { start, end: now })),
      whoopGet(req, rangeUrl("https://api.prod.whoop.com/developer/v2/recovery", { start, end: now })),
      whoopGet(req, rangeUrl("https://api.prod.whoop.com/developer/v2/activity/sleep", { start, end: now }))
    ]);
    res.json({ profile, body, cycles, recovery, sleep });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ───────────────────────────────────────────────────────────────────────────────
// Small, paginated list endpoints (best for GPT). Provide start & end (ISO).
// Use limit (default 50) and nextToken to paginate. trim=true keeps payloads tiny.

app.get("/list/recovery", async (req, res) => {
  try {
    const { start, end, limit = 50, nextToken, trim = "true" } = req.query;
    if (!start || !end) return res.status(400).json({ error: "Provide start & end (ISO datetimes)" });
    const base = "https://api.prod.whoop.com/developer/v2/recovery";
    const page = await fetchPage(req, base, { start, end, limit, nextToken });
    page.records = maybeTrim(page.records, trim === "true");
    res.json(page);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/list/sleep", async (req, res) => {
  try {
    const { start, end, limit = 50, nextToken, trim = "true" } = req.query;
    if (!start || !end) return res.status(400).json({ error: "Provide start & end (ISO datetimes)" });
    const base = "https://api.prod.whoop.com/developer/v2/activity/sleep";
    const page = await fetchPage(req, base, { start, end, limit, nextToken });
    page.records = maybeTrim(page.records, trim === "true");
    res.json(page);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/list/workout", async (req, res) => {
  try {
    const { start, end, limit = 50, nextToken, trim = "true" } = req.query;
    if (!start || !end) return res.status(400).json({ error: "Provide start & end (ISO datetimes)" });
    const base = "https://api.prod.whoop.com/developer/v2/activity/workout";
    const page = await fetchPage(req, base, { start, end, limit, nextToken });
    page.records = maybeTrim(page.records, trim === "true");
    res.json(page);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/list/cycle", async (req, res) => {
  try {
    const { start, end, limit = 50, nextToken, trim = "true" } = req.query;
    if (!start || !end) return res.status(400).json({ error: "Provide start & end (ISO datetimes)" });
    const base = "https://api.prod.whoop.com/developer/v2/cycle";
    const page = await fetchPage(req, base, { start, end, limit, nextToken });
    page.records = maybeTrim(page.records, trim === "true");
    res.json(page);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Basic profile + body measurement (usually small)
app.get("/profile/basic", async (req, res) => {
  try {
    const data = await whoopGet(req, "https://api.prod.whoop.com/developer/v2/user/profile/basic");
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/measurement/body", async (req, res) => {
  try {
    const data = await whoopGet(req, "https://api.prod.whoop.com/developer/v2/user/measurement/body");
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ───────────────────────────────────────────────────────────────────────────────
// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ WHOOP proxy running on ${PORT} (BASE_URL: ${BASE_URL})`);
});
