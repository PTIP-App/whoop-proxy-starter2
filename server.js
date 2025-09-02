// server.js
import express from "express";
import fetch from "node-fetch";
import session from "express-session";
import path from "path";
import { fileURLToPath } from "url";
import Redis from "ioredis";

const { REDIS_URL } = process.env;
const redis = REDIS_URL ? new Redis(REDIS_URL) : null;

async function saveTokens(tokens) {
  if (redis) {
    await redis.set("whoop_tokens", JSON.stringify(tokens));
  } else {
    globalTokens = tokens; // fallback if no Redis configured
  }
}

async function loadTokens() {
  if (redis) {
    const s = await redis.get("whoop_tokens");
    return s ? JSON.parse(s) : null;
  }
  return globalTokens;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const {
  WHOOP_CLIENT_ID,
  WHOOP_CLIENT_SECRET,
  BASE_URL = "http://localhost:3000",
  SESSION_SECRET = "change-this-session-secret"
} = process.env;

if (!WHOOP_CLIENT_ID || !WHOOP_CLIENT_SECRET) {
  console.warn("⚠️  Missing WHOOP_CLIENT_ID or WHOOP_CLIENT_SECRET env vars.");
}

const WHOOP_AUTH = "https://api.prod.whoop.com/oauth/oauth2/auth";
const WHOOP_TOKEN = "https://api.prod.whoop.com/oauth/oauth2/token";

const app = express();
app.use(express.json());
app.use(session({ secret: SESSION_SECRET, resave: false, saveUninitialized: true }));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public/index.html"));
});

// Start WHOOP connect flow
app.get("/connect/whoop", (req, res) => {
  const scope = encodeURIComponent("read:profile read:body_measurement read:cycles read:recovery read:sleep read:workout offline");
  const state = Math.random().toString(36).slice(2,10);
  req.session.oauth_state = state;
  const url = `${WHOOP_AUTH}?response_type=code&client_id=${WHOOP_CLIENT_ID}&redirect_uri=${encodeURIComponent(BASE_URL + "/oauth/callback")}&scope=${scope}&state=${state}`;
  res.redirect(url);
});

// OAuth callback to exchange code for tokens
app.get("/oauth/callback", async (req, res) => {
  const { code, state } = req.query;
  if (state !== req.session.oauth_state) return res.status(400).send("Bad state");
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
  const tokens = await r.json();
  req.session.tokens = tokens;
await saveTokens(tokens);
});

async function refresh(req) {
  if (!req.session?.tokens?.refresh_token) throw new Error("No refresh token");
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: req.session.tokens.refresh_token,
    client_id: WHOOP_CLIENT_ID,
    client_secret: WHOOP_CLIENT_SECRET,
    scope: "offline"
  });
  const r = await fetch(WHOOP_TOKEN, { method: "POST", body });
  if (!r.ok) throw new Error(`Refresh failed ${r.status}`);
  const tokens = await r.json();
  req.session.tokens = tokens;
  return tokens.access_token;
}

async function whoopGet(req, url) {
  let tokens = req.session?.tokens || await loadTokens();
  if (!tokens?.access_token) throw new Error("Not connected to WHOOP yet. Visit /connect/whoop");

  const doFetch = async (accessToken) =>
    fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });

  let r = await doFetch(tokens.access_token);

  if (r.status === 401) {
    if (!tokens.refresh_token) throw new Error("Missing refresh token");
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: WHOOP_CLIENT_ID,
      client_secret: WHOOP_CLIENT_SECRET,
      scope: "offline"
    });
    const rr = await fetch(WHOOP_TOKEN, { method: "POST", body });
    if (!rr.ok) throw new Error(`Refresh failed ${rr.status}`);
    const newTokens = await rr.json();
    if (req.session) req.session.tokens = newTokens;
    await saveTokens(newTokens);
    r = await doFetch(newTokens.access_token);
  }

  if (!r.ok) {
    const text = await r.text();
    throw new Error(`WHOOP error ${r.status}: ${text}`);
  }
  return r.json();
}

}

// Simple endpoints for ChatGPT
app.get("/me/summary", async (req, res) => {
  try {
    const now = new Date().toISOString();
    const start = new Date(Date.now() - 30*24*3600*1000).toISOString();
    const [profile, body, cycles, recovery, sleep] = await Promise.all([
      whoopGet(req, "https://api.prod.whoop.com/developer/v2/user/profile/basic"),
      whoopGet(req, "https://api.prod.whoop.com/developer/v2/user/measurement/body"),
      whoopGet(req, `https://api.prod.whoop.com/developer/v2/cycle?start=${start}&end=${now}`),
      whoopGet(req, `https://api.prod.whoop.com/developer/v2/recovery?start=${start}&end=${now}`),
      whoopGet(req, `https://api.prod.whoop.com/developer/v2/activity/sleep?start=${start}&end=${now}`)
    ]);
    res.json({ profile, body, cycles, recovery, sleep });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/today/recovery", async (req, res) => {
  try {
    const start = new Date(); start.setHours(0,0,0,0);
    const end = new Date(); end.setHours(23,59,59,999);
    const data = await whoopGet(req, `https://api.prod.whoop.com/developer/v2/recovery?start=${start.toISOString()}&end=${end.toISOString()}&limit=1`);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// serve OpenAPI
app.get("/openapi.json", (req, res) => {
  res.sendFile(path.join(__dirname, "openapi.json"));
});

const PORT = process.env.PORT || 3000;
app.use("/public", express.static(path.join(__dirname, "public")));
app.listen(PORT, () => console.log(`✅ WHOOP proxy running on ${PORT}`));
