# Insurance Portal — GCPL (gcpl.insurance-portal.in)

A secure, full-stack employee insurance management dashboard with role-based access control.

## Project Structure

```
insurance-portal/
├── backend/              ← Node.js/Express API (deployed to Render)
│   ├── src/
│   │   ├── index.js      ← Main server, auth middleware, rate limiting
│   │   └── routes/
│   │       ├── auth.js   ← Login, logout, token refresh
│   │       ├── tables.js ← CRUD for all 20 tables
│   │       ├── views.js  ← Read-only database views
│   │       ├── export.js ← Data export endpoint
│   │       └── admin.js  ← User management (admin only)
│   ├── .env.example
│   └── package.json
│
├── frontend/             ← React + Vite (deployed to Render Static Site)
│   ├── src/
│   │   ├── lib/api.js    ← Secure API client (NO Supabase keys here)
│   │   ├── components/   ← Reusable UI components
│   │   ├── pages/        ← Route pages
│   │   └── hooks/        ← React hooks
│   ├── .env.example
│   └── package.json
│
└── README.md
```

## Security Model

```
Browser  →  Your Backend (Render)  →  Supabase
              ↑
         SERVICE_ROLE key lives here only
         JWT verified on every request
         Rate limited: 200 req/15min
         CORS locked to your domains
         Input validated
```

**The browser never touches Supabase directly. No API keys in frontend code.**

## Deployment

### Step 1 — Supabase
1. Run `rls_migration.sql` in SQL Editor
2. Note your **Project URL** and **Service Role Key** (from Settings → API)

### Step 2 — GitHub
```bash
git init
git add .
git commit -m "initial commit"
gh repo create gcpl-insurance-portal --private
git push -u origin main
```

### Step 3 — Render (Backend API)
1. Go to https://render.com → New → Web Service
2. Connect your GitHub repo
3. Settings:
   - **Root Directory:** `backend`
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Environment:** Add these env vars:
     ```
     SUPABASE_URL=https://xxx.supabase.co
     SUPABASE_SERVICE_ROLE_KEY=eyJhbGc...
     ALLOWED_ORIGINS=https://gcpl.insurance-portal.in
     NODE_ENV=production
     ```
4. Deploy → note the URL (e.g. `https://insurance-api-xxxx.onrender.com`)

### Step 4 — Render (Frontend)
1. Render → New → Static Site
2. Connect same GitHub repo
3. Settings:
   - **Root Directory:** `frontend`
   - **Build Command:** `npm install && npm run build`
   - **Publish Directory:** `dist`
   - **Environment:**
     ```
     VITE_API_URL=https://insurance-api-xxxx.onrender.com/api
     VITE_COMPANY_NAME=Global Calcium Pharmaceuticals
     VITE_COMPANY_CODE=GCPL
     ```

### Step 5 — Custom Domain (GoDaddy)
In GoDaddy DNS Manager, add:

| Type  | Name                         | Value                              |
|-------|------------------------------|------------------------------------|
| CNAME | gcpl.insurance-portal.in     | insurance-portal-frontend.onrender.com |
| CNAME | api.insurance-portal.in      | insurance-api-xxxx.onrender.com    |
| CNAME | enroll.insurance-portal.in   | insurance-portal-enroll.onrender.com |

Then in Render: Settings → Custom Domains → add `gcpl.insurance-portal.in`
Render auto-provisions free SSL via Let's Encrypt.

### Step 6 — Cloudflare (Optional but Recommended)
1. Sign up at cloudflare.com (free)
2. Add domain `insurance-portal.in`
3. Change GoDaddy nameservers to Cloudflare's
4. Benefits: WAF, DDoS protection, IP hiding, free SSL, caching

## Role Permissions

| Feature                    | Admin | HR  | Employee |
|----------------------------|-------|-----|----------|
| View all employees         | ✅    | ✅  | ❌       |
| View own record            | ✅    | ✅  | ✅       |
| Add/Edit records           | ✅    | ✅  | ❌       |
| Delete records             | ✅    | ❌  | ❌       |
| View finance tables        | ✅    | ✅  | ❌       |
| View all 34 DB views       | ✅    | ✅  | Partial  |
| Export Excel/PDF           | ✅    | ✅  | Own only |
| User management            | ✅    | ❌  | ❌       |
| Employee Full View         | ✅    | ✅  | Own only |
