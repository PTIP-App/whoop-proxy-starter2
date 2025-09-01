# WHOOP Proxy Starter

A tiny Node.js server that connects to your WHOOP account and exposes simple endpoints your custom ChatGPT can call via Actions.

## Environment Variables
- `WHOOP_CLIENT_ID` – from WHOOP developer portal
- `WHOOP_CLIENT_SECRET` – from WHOOP developer portal
- `BASE_URL` – your public URL (e.g. `https://your-app.onrender.com`)
- `SESSION_SECRET` – any random string

## OAuth Redirect
Set your WHOOP app redirect to: `BASE_URL/oauth/callback`

## Endpoints
- `/connect/whoop` – one-time connect flow
- `/today/recovery` – latest recovery for today
- `/me/summary` – 30-day summary (profile, body, cycles, recovery, sleep)
- `/openapi.json` – minimal OpenAPI document for ChatGPT Actions
