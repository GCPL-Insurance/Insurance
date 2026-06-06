import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { createClient } from '@supabase/supabase-js';
import { authLimiter, enrollmentLimiter } from './limiters.js';

// ─── Prevent silent crashes on unhandled async errors ────────────────────────
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
  // Do NOT exit — log and continue serving
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
  // Do NOT exit — log and continue serving
});

// ─── Validate critical env vars at startup ────────────────────────────────────
const REQUIRED_ENV = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'ALLOWED_ORIGINS', 'JWT_SECRET', 'JWT_REFRESH_SECRET'];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`❌ FATAL: Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

// Warn if service key looks like an anon key (anon keys have role:"anon" in JWT payload)
// NOTE: We warn but never exit here — an undecipherable key is not fatal at startup;
// Supabase calls will fail naturally with a clear error if the key is truly wrong.
try {
  const payload = JSON.parse(Buffer.from(process.env.SUPABASE_SERVICE_ROLE_KEY.split('.')[1], 'base64').toString());
  if (payload.role !== 'service_role') {
    console.warn('⚠️  WARNING: SUPABASE_SERVICE_ROLE_KEY does not appear to be a service_role key (role=' + payload.role + '). Check Render env vars!');
  } else {
    console.log('✅ Supabase service_role key validated');
  }
} catch {
  console.warn('⚠️  Could not decode SUPABASE_SERVICE_ROLE_KEY JWT — proceeding anyway');
}

// ─── Supabase (SERVICE_ROLE — server-side only, NEVER exposed to browser) ─────
export const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

const app = express();

// ─── Trust Render's load-balancer proxy ──────────────────────────────────────
// Render (and most PaaS providers) sit behind a reverse proxy that sets the
// X-Forwarded-For header. Without this, express-rate-limit throws a
// ValidationError (ERR_ERL_UNEXPECTED_X_FORWARDED_FOR) and crashes the process.
app.set('trust proxy', 1);

// ─── Security Headers ─────────────────────────────────────────────────────────
app.use(helmet());

// ─── CORS ─────────────────────────────────────────────────────────────────────
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim()).filter(Boolean);
app.use(cors({
  origin: (origin, cb) => {
    // Allow server-to-server calls (no origin) and listed origins
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    console.warn(`CORS blocked: ${origin}`);
    cb(new Error(`CORS blocked: ${origin}`));
  },
  credentials: true,
}));

app.use(express.json({ limit: '1mb' }));

// ─── Global rate limit: 300 req/15min per IP ─────────────────────────────────
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down.' },
}));

// ─── Auth rate limit: 10 attempts/15min ──────────────────────────────────────
// authLimiter and enrollmentLimiter are imported from ./limiters.js above.
// Re-exported here so any other files importing them from index.js still work.
export { authLimiter, enrollmentLimiter };

// ─── JWT middleware ───────────────────────────────────────────────────────────
// Verifies Supabase JWT, loads profile, attaches to req.user
export async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing authorization header' });
  }
  const token = authHeader.slice(7);

  // Verify token with Supabase
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  // Fetch role + status from user_profiles
  const { data: profile, error: profileErr } = await supabase
    .from('user_profiles')
    .select('role, emp_id, full_name, is_active')
    .eq('id', user.id)
    .single();

  if (profileErr || !profile) {
    return res.status(401).json({ error: 'User profile not found. Contact admin.' });
  }
  if (!profile.is_active) {
    return res.status(403).json({ error: 'Account is deactivated. Contact admin.' });
  }

  req.user = {
    id: user.id,
    email: user.email,
    role: profile.role || 'employee',
    emp_id: profile.emp_id,
    full_name: profile.full_name,
  };
  next();
}

// ─── Role guard middleware ────────────────────────────────────────────────────
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user?.role)) {
      return res.status(403).json({ error: `Access denied. Required role: ${roles.join(' or ')}` });
    }
    next();
  };
}

// ─── Routes ───────────────────────────────────────────────────────────────────
import authRoutes      from './routes/auth.js';
import tableRoutes     from './routes/tables.js';
import viewRoutes      from './routes/views.js';
import exportRoutes    from './routes/export.js';
import adminRoutes     from './routes/admin.js';
import onboardingRoutes from './routes/onboarding.js';
import renewalRoutes, { 
  initializeEnrollmentWindow, 
  startEnrollmentWindowPolling 
} from './routes/renewal.js';

// authLimiter is now applied per-route inside auth.js (login/signup only).
// Enrollment routes (/api/auth/enrollment, /api/auth/enrollment-data) are
// protected by requireAuth (JWT) but NOT by the login rate limiter.
app.use('/api/auth', authRoutes);
app.use('/api/onboarding', onboardingRoutes);
app.use('/api/data',       requireAuth, tableRoutes);
app.use('/api/views',      requireAuth, viewRoutes);
app.use('/api/export',     requireAuth, exportRoutes);
app.use('/api/renewal',    requireAuth, renewalRoutes);
// Admin-only routes: user management, rate card config, etc.
// Enrollment review is accessible to both admin AND hr — see onboarding.js for hr-specific routes.
// NOTE: requireRole('admin','hr') on /api/admin gives HR read + enrollment access but
// the user_management endpoint additionally checks for admin role at the handler level.
app.use('/api/admin',      requireAuth, requireRole('admin', 'hr'), adminRoutes);

// ─── /api/auth/me — validate token and return user ───────────────────────────
// NOTE: this must be BEFORE the 404 handler but AFTER authRoutes so authLimiter applies
app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({
    user: {
      id: req.user.id,
      email: req.user.email,
      role: req.user.role,
      emp_id: req.user.emp_id,
      full_name: req.user.full_name,
    }
  });
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

// ─── 404 ──────────────────────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// ─── Global error handler ─────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  // Don't leak CORS error details
  if (err.message?.startsWith('CORS blocked')) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  console.error('[unhandled error]', err.stack || err.message);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 4000;
const server = app.listen(PORT, async () => {
  console.log(`🚀 API running on port ${PORT} [${process.env.NODE_ENV || 'development'}]`);

  // ✅ FIX: Initialize enrollment window from database on startup
  try {
    await initializeEnrollmentWindow();
    console.log('[Startup] ✅ Enrollment window initialized from database');
  } catch (e) {
    console.warn('[Startup] ⚠️  Failed to initialize enrollment window:', e.message);
  }

  // ✅ FIX: Start polling enrollment window every 30 seconds
  try {
    startEnrollmentWindowPolling();
    console.log('[Startup] ✅ Enrollment window polling started (30s interval)');
  } catch (e) {
    console.warn('[Startup] ⚠️  Failed to start enrollment window polling:', e.message);
  }
});

// ── Prevent "Failed to fetch" on Render free tier ──────────────────────────
// Render's load balancer has a 55s idle timeout. Set server timeouts slightly
// longer so the backend sends a proper response/error instead of silently
// dropping the TCP connection (which causes browser "Failed to fetch").
server.keepAliveTimeout = 61000;   // 61s — must exceed Render's 55s LB timeout
server.headersTimeout   = 65000;   // slightly above keepAliveTimeout

export { requireAuth as default };
