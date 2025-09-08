// server.js — WHOOP proxy (single user, beginner-friendly)
// Node 18+ (ESM). Express + node-fetch + express-session.
// Auto-paginates so WHOOP's limit<=25 never blocks you.

import express from "express";
import fetch from "node-fetch";
import session from "express-session";
import https from "node:https";

// ───────────────────────────────────────────────────────────────────────────────
// ENV (Render → Settings → Environment Variables)
// Required: WHOOP_CLIENT_ID, WHOOP_CLIENT_SECRET, SESSION_SECRET
// Recommended: BASE_URL = https://whoop-proxy.onrender.com  (no trailing slash)
const {
  WHOOP_CLIENT_ID,
  WHOOP_CLIENT_SECRET,
  BASE_URL = "https://whoop-proxy.onrender.com",
  SESSION_SECRET = "change-this-session-secret"
} = process.env;

if (!WHOOP_CLIENT_ID || !WHOOP_CLIENT_SECRET) {
  console.warn("⚠️ Missing WHOOP_CLIENT_ID or WHOOP_CLIENT_SECRET.");
}

// WHOOP OAuth + API endpoints (v2)
const WHOOP_AUTH = "https://api.prod.whoop.com/oauth/oauth2/auth";
const WHOOP_TOKEN = "https://api.prod.whoop.com/oauth/oauth2/token";

// Single-user token fallback (so GPT calls work without cookies).
// NOTE: tokens reset on restart (okay for starter). For persistence, add Redis later.
let globalTokens = null;

// WHOOP hard cap per request; do not exceed this when calling WHOOP.
const WHOOP_PAGE_MAX = 25;

// Reuse a single HTTPS agent to keep connections alive
const keepAliveAgent = new https.Agent({ keepAlive: true });

// ───────────────────────────────────────────────────────────────────────────────
// App setup
const app = express();
app.use(express.json());

// Tiny request logger so you can see what the GPT is calling in Render → Logs
app.use((req, _res, next) => {
  console.log("REQ", req.method, req.url);
  next();
});

// Sessions (used only for OAuth state + optional session token copy)
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: true
  })
);

// Simple homepage (no static files needed)
app.get("/", (_req, res) => {
  res
    .type("html")
    .send(
      `<h1>WHOOP Proxy</h1>
       <p><a href="/connect/whoop">Connect to WHOOP</a></p>
       <p><a href="/openapi.json">/openapi.json</a></p>`
    );
});

// Serve OpenAPI (make sure openapi.json exists in repo root)
app.get("/openapi.json", (_req, res) => {
  import("node:fs").then(fs => {
    fs.readFile("openapi.json", "utf8", (err, text) => {
      if (err) return res.status(404).send("openapi.json not found");
      res.type("application/json").send(text);
    });
  });
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
    const tokens = await r.json(); // { access_token, refresh_token, ... }

    req.session.tokens = tokens;
    globalTokens = tokens; // fallback for GPT/server calls

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

// Fetch a WHOOP URL with auth; on 401, refresh once
async function whoopGet(req, url) {
  // prefer session tokens, fallback to global
  let tokens = req.session?.tokens || globalTokens;
  if (!tokens?.access_token) {
    throw new Error("Not connected to WHOOP yet. Visit /connect/whoop");
  }

  const doFetch = (accessToken) =>
    fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      agent: keepAliveAgent
    });

  let r;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      r = await doFetch(tokens.access_token);

      if (r.status === 401) {
        const newTokens = await refreshTokens(tokens);
        if (req.session) req.session.tokens = newTokens;
        globalTokens = newTokens;
        tokens = newTokens;
        r = await doFetch(tokens.access_token);
      }

      if (r.status >= 500 && attempt < 2) {
        await new Promise(res => setTimeout(res, 300 * (attempt + 1)));
        continue;
      }
      break;
    } catch (err) {
      if (attempt === 2) throw err;
      await new Promise(res => setTimeout(res, 300 * (attempt + 1)));
    }
  }

  if (!r.ok) {
    const text = await r.text();
    throw new Error(`WHOOP error ${r.status}: ${text}`);
  }
  return r.json();
}

// ───────────────────────────────────────────────────────────────────────────────
// Date normalizers (accept YYYY / YYYY-MM / YYYY-MM-DD / full ISO)

function normalizeStartISO(s) {
  if (!s) return s;
  if (/^\d{4}$/.test(s)) return `${s}-01-01T00:00:00.000Z`;          // YYYY
  if (/^\d{4}-\d{2}$/.test(s)) return `${s}-01T00:00:00.000Z`;       // YYYY-MM
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s}T00:00:00.000Z`;    // YYYY-MM-DD
  const d = new Date(s);
  if (isNaN(d)) throw new Error("Invalid start date");
  return d.toISOString();
}

function normalizeEndISO(s) {
  if (!s) return s;
  if (/^\d{4}$/.test(s)) {                                          // YYYY → end of year
    const y = Number(s);
    const next = new Date(Date.UTC(y + 1, 0, 1));
    return new Date(next.getTime() - 1).toISOString();
  }
  if (/^\d{4}-\d{2}$/.test(s)) {                                    // YYYY-MM → end of month
    const [y, m] = s.split("-").map(Number);
    const next = new Date(Date.UTC(y, m, 1)); // next month
    return new Date(next.getTime() - 1).toISOString();
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s}T23:59:59.999Z`;   // end of day
  const d = new Date(s);
  if (isNaN(d)) throw new Error("Invalid end date");
  return d.toISOString();
}

// ───────────────────────────────────────────────────────────────────────────────
// Helpers for paging & trimming

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
    "date",
    "createdAt",
    "updatedAt",
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

// Fetch one WHOOP page (records + nextToken)
async function fetchPage(req, base, args) {
  const url = rangeUrl(base, args);
  const page = await whoopGet(req, url);
  return {
    records: Array.isArray(page.records) ? page.records : [],
    nextToken: page.nextToken || page.next_token || null
  };
}

// Auto-paginate until we collect desiredCount (or all if desiredCount===Infinity)
async function fetchAuto(req, base, { start, end, desiredCount, perPage, firstNextToken }) {
  let nextToken = firstNextToken || null;
  const out = [];
  perPage = Math.min(WHOOP_PAGE_MAX, Math.max(1, Math.floor(perPage || WHOOP_PAGE_MAX)));

  while (out.length < desiredCount && (out.length === 0 || nextToken !== null)) {
    const { records, nextToken: nt } = await fetchPage(req, base, {
      start, end, limit: perPage, nextToken
    });
    out.push(...records);
    nextToken = nt;
    if (!nextToken) break;
  }
  return { records: out.slice(0, desiredCount), nextToken };
}

// ───────────────────────────────────────────────────────────────────────────────
// Convenience routes

app.get("/today/recovery", async (req, res) => {
  try {
    const start = new Date(); start.setUTCHours(0, 0, 0, 0);
    const end = new Date(); end.setUTCHours(23, 59, 59, 999);
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

// 30-day bundle (can be large; prefer /list/* for GPT)
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
// Paginated list endpoints — now auto-paginate.
// You can pass:
//   - limit=N  (N>25 means "return up to N", auto-paging in 25s)
//   - all=true (fetch everything in range; be careful with very large ranges)
//   - trim=true/false (default true)

async function handleList(req, res, base) {
  try {
    const { start, end, limit, nextToken, trim = "true", all } = req.query;
    if (!start || !end) return res.status(400).json({ error: "Provide start & end (dates or ISO datetimes)" });

    const startISO = normalizeStartISO(start);
    const endISO = normalizeEndISO(end);
    const wantAll = String(all).toLowerCase() === "true";

    // Desired total to return:
    let desired = Infinity;
    if (!wantAll) {
      const requested = Number(limit);
      desired = Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : WHOOP_PAGE_MAX;
    }

    // Per-page to WHOOP (NEVER above 25)
    const perPage = Math.min(WHOOP_PAGE_MAX, Number.isFinite(Number(limit)) ? Math.max(1, Math.min(WHOOP_PAGE_MAX, Math.floor(Number(limit)))) : WHOOP_PAGE_MAX);

    // If desired <= 25 and no pagination requested, fetch once for speed:
    if (!wantAll && desired <= WHOOP_PAGE_MAX && !nextToken) {
      const page = await fetchPage(req, base, { start: startISO, end: endISO, limit: Math.min(desired, WHOOP_PAGE_MAX) });
      page.records = maybeTrim(page.records, trim === "true");
      return res.json(page);
    }

    // Otherwise auto-paginate to meet desired (or all)
    const { records, nextToken: finalToken } = await fetchAuto(req, base, {
      start: startISO,
      end: endISO,
      desiredCount: wantAll ? Infinity : desired,
      perPage,
      firstNextToken: nextToken || null
    });

    res.json({
      records: maybeTrim(records, trim === "true"),
      nextToken: finalToken // null if fully exhausted
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

app.get("/list/recovery", (req, res) =>
  handleList(req, res, "https://api.prod.whoop.com/developer/v2/recovery")
);

app.get("/list/sleep", (req, res) =>
  handleList(req, res, "https://api.prod.whoop.com/developer/v2/activity/sleep")
);

app.get("/list/workout", (req, res) =>
  handleList(req, res, "https://api.prod.whoop.com/developer/v2/activity/workout")
);

app.get("/list/cycle", (req, res) =>
  handleList(req, res, "https://api.prod.whoop.com/developer/v2/cycle")
);

// Profile + body (small)
app.get("/profile/basic", async (_req, res) => {
  try {
    const data = await whoopGet(_req, "https://api.prod.whoop.com/developer/v2/user/profile/basic");
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/measurement/body", async (_req, res) => {
  try {
    const data = await whoopGet(_req, "https://api.prod.whoop.com/developer/v2/user/measurement/body");
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Optional: list available routes for debugging
app.get("/__debug/routes", (_req, res) => {
  const routes = [];
  app._router.stack.forEach(mw => {
    if (mw.route && mw.route.path) {
      const methods = Object.keys(mw.route.methods).join(",").toUpperCase();
      routes.push(`${methods} ${mw.route.path}`);
    }
  });
  res.json({ routes });
});

// ───────────────────────────────────────────────────────────────────────────────
// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ WHOOP proxy running on ${PORT} (BASE_URL: ${BASE_URL})`);
});
