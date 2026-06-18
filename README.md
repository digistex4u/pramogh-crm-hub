# 💎 Pramogh CRM + WhatsApp Hub (Secure)

Server-side API key protection via Vercel Edge Functions. WATI tokens **never reach the browser**.

## Architecture

```
Browser (index.html)          Vercel Edge Functions         WATI API
─────────────────────         ──────────────────────         ────────
                               
  POST /api/send        →     api/send.js                →  WATI endpoint
  {channelId, phone,          (reads WATI_CHANNELS env)     (with Bearer token)
   message}                   (adds Authorization header)
                              
  GET /api/channels     →     api/channels.js            
  (returns names only)        (strips tokens from response)
                              
  POST /api/auth        →     api/auth.js
  {password}                  (validates SITE_PASSWORD env)
                              (sets HttpOnly session cookie)
  
  ALL other requests    →     middleware.js
                              (checks session cookie)
                              (blocks unauthorized access)
```

## What's Protected

| Data | Where Stored | Visible to Browser? |
|------|-------------|-------------------|
| WATI API tokens | Vercel env vars | ❌ Never |
| WATI endpoint URLs | Vercel env vars | ❌ Never |
| Site password | Vercel env var | ❌ Never |
| Contact lists | Browser localStorage | ✅ Current user only |
| Broadcast history | Browser localStorage | ✅ Current user only |
| CRM data (64K contacts) | Embedded in HTML | ✅ After login only |

## Deploy

### 1. Push to GitHub

```bash
git init
git add .
git commit -m "initial deploy"
git remote add origin https://github.com/digistex4u/pramogh-crm-hub.git
git push -u origin main
```

### 2. Import in Vercel

1. Go to [vercel.com/new](https://vercel.com/new)
2. Select `pramogh-crm-hub` repo
3. Framework: **Other**
4. Click **Deploy**

### 3. Add Environment Variables (CRITICAL)

1. In Vercel → your project → **Settings** → **Environment Variables**
2. Add these:

| Name | Value | Example |
|------|-------|---------|
| `SITE_PASSWORD` | Your site access password | `Pramogh@2026` |
| `WATI_CHANNELS` | JSON with channel configs | See below |

**WATI_CHANNELS format:**
```json
{
  "main": {
    "name": "Pramogh Main",
    "url": "https://live-mt-server.wati.io/305XXX/api",
    "token": "Bearer eyJhbG..."
  },
  "support": {
    "name": "Pramogh Support",
    "url": "https://live-mt-server.wati.io/306XXX/api",
    "token": "Bearer eyJhbG..."
  }
}
```

3. After adding env vars, click **Redeploy** (Settings → Deployments → ⋮ → Redeploy)

### 4. Test

1. Open `pramogh-crm-hub.vercel.app`
2. Enter site password → Dashboard loads
3. Go to WhatsApp tab → Channels should show with "🔒 Token secured server-side"
4. Select channel + list → Send

## Adding / Changing Channels

1. Go to Vercel → Settings → Environment Variables
2. Edit `WATI_CHANNELS` — add/remove/update channel entries
3. Redeploy

No code changes needed. No browser data exposed.

## File Structure

```
pramogh-crm-hub/
├── public/
│   └── index.html        ← Dashboard (NO API keys)
├── api/
│   ├── auth.js           ← Password verification
│   ├── channels.js       ← Returns channel names (no tokens)
│   └── send.js           ← Proxies messages to WATI
├── middleware.js          ← Site-wide auth wall
├── vercel.json           ← Vercel config
├── package.json
└── .env.example          ← Template for env vars
```
