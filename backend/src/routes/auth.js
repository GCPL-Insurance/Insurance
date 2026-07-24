import { Router } from 'express';
import { supabase } from '../index.js';
import { requireAuth } from '../index.js';
import { authLimiter, enrollmentLimiter } from '../limiters.js';
import crypto from 'node:crypto';

const router = Router();

// ─── Email OTP (2FA) + trusted devices ─────────────────────────────────────────
const OTP_ENABLED = (process.env.OTP_ENABLED || 'false').toLowerCase() === 'true';
const OTP_PEPPER  = process.env.OTP_PEPPER || (process.env.RENEWAL_FN_SECRET || 'change-me');
const OTP_TTL_MIN = 5;
const OTP_MAX_ATTEMPTS = 5;
const OTP_RESEND_COOLDOWN_MS = 60 * 1000;
const OTP_MAX_RESENDS = 3;
const DEVICE_TRUST_DAYS = 30;
const FN_BASE   = `${process.env.SUPABASE_URL || ''}/functions/v1`;
const FN_SECRET = process.env.RENEWAL_FN_SECRET || '';

const _otpHash   = (code) => crypto.createHmac('sha256', OTP_PEPPER).update(String(code)).digest('hex');
const _tokenHash = (t)    => crypto.createHash('sha256').update(String(t)).digest('hex');
const _genOtp    = ()     => String(crypto.randomInt(0, 1000000)).padStart(6, '0');
const _genDevice = ()     => crypto.randomBytes(32).toString('hex');
const _maskEmail = (e) => { const [u, d] = String(e).split('@'); return (u ? u[0] + '***' : '') + '@' + (d || ''); };

async function _sendOtpEmail(to, fullName, code) {
  try {
    await fetch(`${FN_BASE}/send-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY || ''}` },
      body: JSON.stringify({ secret: FN_SECRET, to, full_name: fullName, code, ttl_minutes: OTP_TTL_MIN }),
    });
  } catch (e) { console.error('[otp] send failed:', e?.message || e); }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Validate password strength: 8+ chars, at least one letter and one digit */
function validatePassword(password) {
  if (!password || typeof password !== 'string') return 'Password is required';
  if (password.length < 8) return 'Password must be at least 8 characters';
  if (!/[a-zA-Z]/.test(password)) return 'Password must contain at least one letter';
  if (!/\d/.test(password)) return 'Password must contain at least one number';
  return null; // valid
}

/** Validate email format */
function validateEmail(email) {
  if (!email || typeof email !== 'string') return 'Email is required';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return 'Invalid email format';
  return null;
}

/**
 * Normalize date input to YYYY-MM-DD accepted by Postgres DATE.
 * Supports YYYY-MM-DD and DD-MM-YYYY (common portal input format).
 */
function normalizeDateForPg(value) {
  if (!value || typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const dmy = raw.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
  return raw;
}

/** True if DB error indicates missing column in target table. */
function isMissingColumnError(err, columnName = '') {
  const msg = err?.message || '';
  const details = err?.details || '';
  const combined = `${msg} ${details}`;
  const colCheck = columnName ? columnName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '[a-zA-Z0-9_]+';
  return new RegExp(`column\\s+"?${colCheck}"?\\s+does not exist`, 'i').test(combined);
}

/** True if DB error is a duplicate/unique-constraint violation (PG code 23505). */
function isDuplicateKeyError(err) {
  const code = err?.code || err?.details || '';
  const msg  = err?.message || '';
  return code === '23505' || /duplicate key|unique.*constraint|already exists/i.test(msg);
}

/** Verify Cloudflare Turnstile captcha token */
async function verifyCaptcha(token, remoteip) {
  if (!token) return { success: false, error: 'Captcha token missing. Please complete the security check.' };
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) {
    if (process.env.NODE_ENV !== 'production') return { success: true };
    return { success: false, error: 'Captcha not configured on server.' };
  }
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    let resp;
    try {
      resp = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret, response: token, ...(remoteip ? { remoteip } : {}) }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }
    const result = await resp.json();
    if (!result.success) return { success: false, error: 'Security check failed. Please try again.' };
    return { success: true };
  } catch (err) {
    if (err.name === 'AbortError') {
      console.error('[captcha] verification timed out after 5s — allowing login to proceed');
      return { success: true }; // Fail open: Cloudflare outage must not lock all users out
    }
    console.error('[captcha] verification failed:', err.message);
    return { success: false, error: 'Could not verify security check. Please try again.' };
  }
}

/**
 * Translate a Supabase auth.admin.createUser error into a friendly message.
 */
function friendlyAuthError(authErr, context = '') {
  const msg = authErr?.message || '';
  console.error(`[auth.admin.createUser${context ? ' ' + context : ''}] code=${authErr?.status} message=${msg}`);
  if (/already registered|already exists/i.test(msg))
    return { status: 409, error: 'This email is already registered. Please sign in.' };
  if (/user not allowed|not allowed|signup.*disabled|email.*disabled/i.test(msg))
    return { status: 400, error: 'Account creation is restricted. Please contact HR to register your account.' };
  if (/weak password/i.test(msg))
    return { status: 400, error: 'Password too weak. Use at least 8 characters with letters and numbers.' };
  if (/invalid.*email/i.test(msg))
    return { status: 400, error: 'Invalid email address.' };
  return { status: 500, error: 'Account creation failed. Please try again or contact HR.' };
}

// ─── POST /api/auth/gmc-verify-emp ───────────────────────────────────────────
// Public: check if an emp_id already has an account before showing GMC signup form.
// Priority: employees table (canonical HR master) → employee_onboarding (fallback).
router.post('/gmc-verify-emp', async (req, res) => {
  const { emp_id } = req.body;
  if (!emp_id || typeof emp_id !== 'string') return res.status(400).json({ error: 'emp_id required' });

  const empIdNorm = emp_id.trim().toUpperCase();

  const { data: existingProfile } = await supabase
    .from('user_profiles').select('id').eq('emp_id', empIdNorm).single();
  if (existingProfile)
    return res.status(409).json({ error: 'An account already exists for this Employee ID. Please sign in.' });

  const { data: existingEnroll } = await supabase
    .from('employee_gmc_enrollment').select('enrollment_id, enrollment_status')
    .eq('emp_id', empIdNorm).order('created_at', { ascending: false }).limit(1).single();

  // ── 1. employees table — canonical, most complete ─────────────────────────
  const { data: empRecord } = await supabase
    .from('employees')
    .select('emp_id, emp_name, department, designation, date_of_joining, gender, date_of_birth, is_active, unit, ctc_gmc_per_month, gmc_inclusion_date')
    .eq('emp_id', empIdNorm).single();

  // ── 2. employee_onboarding — fallback for new / not-yet-in-HR-system employees ──
  let onboardingFallback = null;
  if (!empRecord) {
    const { data } = await supabase
      .from('employee_onboarding')
      .select('emp_id, emp_name, department, designation, date_of_joining, gender, date_of_birth, onboarding_status, unit, ctc_gmc_per_month')
      .eq('emp_id', empIdNorm).single();
    onboardingFallback = data;
  }

  const source = empRecord || onboardingFallback;

  res.json({
    verified: true,
    emp_id: empIdNorm,
    from_employees_table: !!empRecord,
    from_onboarding_table: !!onboardingFallback,
    emp_name: source?.emp_name || null,
    department: source?.department || null,
    designation: source?.designation || null,
    date_of_joining: source?.date_of_joining || null,
    gender: source?.gender || null,
    date_of_birth: source?.date_of_birth || null,
    unit: source?.unit || null,
    ctc_gmc_per_month: source?.ctc_gmc_per_month || null,
    gmc_inclusion_date: empRecord?.gmc_inclusion_date || null,
    existing_enrollment: existingEnroll
      ? { id: existingEnroll.enrollment_id, status: existingEnroll.enrollment_status }
      : null,
  });
});

// ─── POST /api/auth/gmc-signup ────────────────────────────────────────────────
// Public: New employee self-registration via GMC portal.
router.post('/gmc-signup', authLimiter, async (req, res) => {
  const {
    emp_id, email, password, full_name, captchaToken,
    gender, date_of_birth, department, designation, date_of_joining, mobile_number, unit,
  } = req.body;

  if (!emp_id || !email || !password || !full_name)
    return res.status(400).json({ error: 'emp_id, email, password, and full_name are required' });

  const emailErr = validateEmail(email);
  if (emailErr) return res.status(400).json({ error: emailErr });
  const pwErr = validatePassword(password);
  if (pwErr) return res.status(400).json({ error: pwErr });

  const captchaResult = await verifyCaptcha(captchaToken, req.ip);
  if (!captchaResult.success) return res.status(400).json({ error: captchaResult.error });

  const empIdNorm = emp_id.trim().toUpperCase();
  const emailNorm = email.trim().toLowerCase();
  const dobNorm   = normalizeDateForPg(date_of_birth);
  const dojNorm   = normalizeDateForPg(date_of_joining);

  const [profileByEmpId, profileByEmail] = await Promise.all([
    supabase.from('user_profiles').select('id').eq('emp_id', empIdNorm).single(),
    supabase.from('user_profiles').select('id').eq('email', emailNorm).single(),
  ]);
  if (profileByEmpId.data)
    return res.status(409).json({ error: 'An account already exists for this Employee ID. Please sign in.' });
  if (profileByEmail.data)
    return res.status(409).json({ error: 'This email is already registered. Please sign in.' });

  const { data: authData, error: authErr } = await supabase.auth.admin.createUser({
    email: emailNorm,
    password,
    email_confirm: true,
    user_metadata: { full_name, emp_id: empIdNorm, role: 'employee' },
  });
  if (authErr) {
    const { status, error } = friendlyAuthError(authErr, 'gmc-signup');
    return res.status(status).json({ error });
  }

  const { error: profileErr } = await supabase.from('user_profiles').upsert({
    id: authData.user.id,
    email: emailNorm,
    full_name,
    emp_id: empIdNorm,
    role: 'employee',
    is_active: true,
  }, { onConflict: 'id' });
  if (profileErr)
    console.error('[gmc-signup] user_profiles upsert failed for', empIdNorm,
      '| code:', profileErr.code, '| msg:', profileErr.message);

  const { data: existingOnboarding } = await supabase
    .from('employee_onboarding').select('emp_id').eq('emp_id', empIdNorm).single();

  if (!existingOnboarding) {
    const onboardingPayload = {
      emp_id: empIdNorm, emp_name: full_name,
      gender: gender || null, date_of_birth: dobNorm || null,
      date_of_joining: dojNorm || null, department: department || null,
      designation: designation || null, mobile_number: mobile_number || null,
      email_id: emailNorm, unit: unit || null, onboarding_status: 'pending',
    };
    const { error: obErr } = await supabase.from('employee_onboarding').insert(onboardingPayload);
    if (obErr) {
      if (isDuplicateKeyError(obErr)) {
        console.warn('[gmc-signup] employee_onboarding duplicate key for', empIdNorm, '— skipping');
      } else if (isMissingColumnError(obErr)) {
        console.error('[gmc-signup] employee_onboarding column mismatch for', empIdNorm, ':', obErr.message);
      } else {
        console.error('[gmc-signup] employee_onboarding insert failed for', empIdNorm,
          '| code:', obErr.code, '| message:', obErr.message);
      }
    }
  } else {
    console.log('[gmc-signup] employee_onboarding record already exists for', empIdNorm, '— skipping insert.');
  }

  const enrollmentPayload = {
    emp_id: empIdNorm, emp_name: full_name,
    gender: gender || null, date_of_birth: dobNorm,
    department: department || null, designation: designation || null,
    date_of_joining: dojNorm, mobile_number: mobile_number || null,
    email_id: emailNorm, selected_sum_insured: 0,
    enrollment_status: 'DRAFT', ctc_gmc_per_month: 0,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  };

  let { error: enrollErr } = await supabase.from('employee_gmc_enrollment').insert(enrollmentPayload);
  if (enrollErr && isMissingColumnError(enrollErr, 'ctc_gmc_per_month')) {
    const { ctc_gmc_per_month, ...payloadWithoutCtc } = enrollmentPayload;
    ({ error: enrollErr } = await supabase.from('employee_gmc_enrollment').insert(payloadWithoutCtc));
  }
  if (enrollErr)
    console.error('[gmc-signup] DRAFT enrollment creation failed for', empIdNorm, ':', enrollErr.message);

  res.status(201).json({
    success: true,
    message: 'Account created! You can now sign in and complete your GMC enrollment.',
    emp_name: full_name,
  });
});

// ─── POST /api/auth/signup ────────────────────────────────────────────────────
// Public: Standard employee self-registration (must already be in employees table).
router.post('/signup', authLimiter, async (req, res) => {
  const { emp_id, email, password, full_name, captchaToken } = req.body;

  if (!emp_id || !email || !password)
    return res.status(400).json({ error: 'emp_id, email, and password are required' });
  const emailErr = validateEmail(email);
  if (emailErr) return res.status(400).json({ error: emailErr });
  const pwErr = validatePassword(password);
  if (pwErr) return res.status(400).json({ error: pwErr });

  const captchaResult = await verifyCaptcha(captchaToken, req.ip);
  if (!captchaResult.success) return res.status(400).json({ error: captchaResult.error });

  const empIdNorm = emp_id.trim().toUpperCase();
  const emailNorm = email.trim().toLowerCase();

  const { data: emp } = await supabase
    .from('employees').select('emp_id, emp_name, is_active').eq('emp_id', empIdNorm).single();

  if (!emp) return res.status(404).json({ error: 'Employee ID not found. Please contact HR.' });
  if (!emp.is_active) return res.status(403).json({ error: 'Employee account is inactive. Contact HR.' });

  const { data: existingProfile } = await supabase
    .from('user_profiles').select('id').eq('emp_id', emp.emp_id).single();
  if (existingProfile)
    return res.status(409).json({ error: 'An account already exists for this Employee ID. Please sign in.' });

  const { data: existingEmail } = await supabase
    .from('user_profiles').select('id').eq('email', emailNorm).single();
  if (existingEmail)
    return res.status(409).json({ error: 'This email is already registered. Please sign in.' });

  const { data: authData, error: authErr } = await supabase.auth.admin.createUser({
    email: emailNorm, password, email_confirm: true,
    user_metadata: { full_name: full_name || emp.emp_name, emp_id: emp.emp_id, role: 'employee' },
  });
  if (authErr) {
    const { status, error } = friendlyAuthError(authErr, 'signup');
    return res.status(status).json({ error });
  }

  const { error: profileErr } = await supabase.from('user_profiles').upsert({
    id: authData.user.id, email: emailNorm, full_name: full_name || emp.emp_name,
    emp_id: emp.emp_id, role: 'employee', is_active: true,
  }, { onConflict: 'id' });
  if (profileErr)
    console.error('[signup] user_profiles upsert failed | code:', profileErr.code, '| msg:', profileErr.message);

  try {
    const { error: linkErr } = await supabase.from('employees')
      .update({ auth_uid: authData.user.id }).eq('emp_id', emp.emp_id);
    if (linkErr) console.warn('[signup] auth_uid link failed:', linkErr.message);
  } catch (e) { console.warn('[signup] auth_uid link threw:', e.message); }

  res.status(201).json({ success: true, message: 'Account created! You can now sign in.', emp_name: emp.emp_name });
});

// ─── POST /api/auth/verify-emp ────────────────────────────────────────────────
// Public: Validate emp_id before showing signup form.
router.post('/verify-emp', async (req, res) => {
  const { emp_id } = req.body;
  if (!emp_id) return res.status(400).json({ error: 'emp_id required' });

  const { data: emp } = await supabase
    .from('employees')
    .select('emp_id, emp_name, department, designation, date_of_joining, is_active')
    .eq('emp_id', emp_id.trim().toUpperCase()).single();

  if (!emp) return res.status(404).json({ error: 'Employee ID not found' });
  if (!emp.is_active) return res.status(403).json({ error: 'Employee account is inactive' });

  const { data: existingProfile } = await supabase
    .from('user_profiles').select('id').eq('emp_id', emp.emp_id).single();
  if (existingProfile)
    return res.status(409).json({ error: 'Account already exists for this Employee ID' });

  res.json({ verified: true, emp_name: emp.emp_name, department: emp.department, designation: emp.designation });
});

// ─── POST /api/auth/login ─────────────────────────────────────────────────────
// Public: Authenticate and return JWT tokens.
// ─── POST /api/auth/set-password ─────────────────────────────────────────────
// Used by employees who received an invite email. They land on the app with
// an access_token + refresh_token in the URL hash (type=invite). The frontend
// extracts those tokens and posts them here with the chosen password.
router.post('/set-password', async (req, res) => {
  const { access_token, refresh_token, new_password } = req.body;

  if (!access_token || !refresh_token)
    return res.status(400).json({ error: 'Invalid invite link. Please request a new invite.' });

  const pwdErr = validatePassword(new_password);
  if (pwdErr) return res.status(400).json({ error: pwdErr });

  // 1. Verify the invite token and get user identity
  const { data: { user }, error: userErr } = await supabase.auth.getUser(access_token);
  if (userErr || !user)
    return res.status(401).json({ error: 'Invite link has expired or is invalid. Please contact admin.' });

  // 2. Set the password via admin API
  const { error: updateErr } = await supabase.auth.admin.updateUserById(user.id, {
    password: new_password,
  });
  if (updateErr) {
    console.error('[set-password] updateUserById failed:', updateErr.message);
    return res.status(500).json({ error: 'Failed to set password. Please try again.' });
  }

  // 3. Sign in with the new password to return a fresh session
  const { data: signInData, error: signInErr } = await supabase.auth.signInWithPassword({
    email: user.email,
    password: new_password,
  });
  if (signInErr) {
    console.error('[set-password] signIn after password set failed:', signInErr.message);
    return res.status(500).json({ error: 'Password set, but auto-login failed. Please log in manually.' });
  }

  // 4. Fetch user profile
  const { data: profile, error: profileErr } = await supabase
    .from('user_profiles').select('role, emp_id, full_name, is_active').eq('id', user.id).single();

  if (profileErr || !profile)
    return res.status(200).json({
      access_token:  signInData.session.access_token,
      refresh_token: signInData.session.refresh_token,
      expires_at:    signInData.session.expires_at,
      user: { id: user.id, email: user.email, role: 'employee', emp_id: null, full_name: user.email },
    });

  res.json({
    access_token:  signInData.session.access_token,
    refresh_token: signInData.session.refresh_token,
    expires_at:    signInData.session.expires_at,
    user: {
      id: user.id, email: user.email,
      role: profile.role || 'employee', emp_id: profile.emp_id, full_name: profile.full_name,
    },
  });
});

// ─── POST /api/auth/login ─────────────────────────────────────────────────────
router.post('/login', authLimiter, async (req, res) => {
  const { email, password, captchaToken } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });

  const emailNorm = email.trim().toLowerCase();

  const captchaResult = await verifyCaptcha(captchaToken, req.ip);
  if (!captchaResult.success) return res.status(400).json({ error: captchaResult.error });

  // Check if user exists in our system first — gives a specific "no account" message
  const { data: profileCheck } = await supabase
    .from('user_profiles').select('id, is_active, emp_id').eq('email', emailNorm).single();

  if (!profileCheck) {
    return res.status(401).json({ error: 'No account found for this email. Contact HR if you need access.' });
  }
  if (!profileCheck.is_active) {
    return res.status(403).json({ error: 'Your account has been deactivated. Please contact HR.' });
  }

  const { data, error } = await supabase.auth.signInWithPassword({ email: emailNorm, password });

  if (error) {
    console.warn('[login] failed for', emailNorm, ':', error.message);
    // Map Supabase auth error codes to human-readable messages
    const msg = error.message?.toLowerCase() || '';
    if (msg.includes('invalid login') || msg.includes('invalid credentials') || msg.includes('wrong password'))
      return res.status(401).json({ error: 'Incorrect password. Please try again.' });
    if (msg.includes('email not confirmed'))
      return res.status(401).json({ error: 'Email not confirmed. Please contact HR.' });
    if (msg.includes('too many') || msg.includes('rate limit'))
      return res.status(429).json({ error: 'Too many failed attempts. Please wait a few minutes before trying again.' });
    if (msg.includes('locked') || msg.includes('disabled'))
      return res.status(403).json({ error: 'Account is locked due to too many failed attempts. Contact HR to unlock.' });
    return res.status(401).json({ error: 'Incorrect password. Please try again.' });
  }

  const { data: profile, error: profileErr } = await supabase
    .from('user_profiles').select('role, emp_id, full_name, is_active, must_change_password').eq('id', data.user.id).single();

  if (profileErr || !profile)
    return res.status(401).json({ error: 'Account not fully set up. Please contact HR.' });
  if (!profile.is_active) {
    await supabase.auth.admin.signOut(data.session.access_token).catch(() => {});
    return res.status(403).json({ error: 'Your account has been deactivated. Contact HR.' });
  }

  // ── 2FA: trusted device skips OTP; otherwise email a one-time code ──
  if (OTP_ENABLED) {
    const deviceToken = (req.body.device_token || '').toString().trim();
    let trusted = false;
    if (deviceToken) {
      const { data: dev } = await supabase.from('trusted_device')
        .select('id').eq('user_id', data.user.id).eq('token_hash', _tokenHash(deviceToken))
        .gt('expires_at', new Date().toISOString()).maybeSingle();
      if (dev) {
        trusted = true;
        supabase.from('trusted_device').update({ last_used_at: new Date().toISOString() }).eq('id', dev.id).then(() => {});
      }
    }
    if (!trusted) {
      const code = _genOtp();
      const pendingSession = {
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
        expires_at: data.session.expires_at,
        user: {
          id: data.user.id, email: data.user.email,
          role: profile.role || 'employee', emp_id: profile.emp_id, full_name: profile.full_name,
          must_change_password: profile.must_change_password ?? false,
        },
      };
      const { data: pend, error: pErr } = await supabase.from('login_otp_pending').insert({
        user_id: data.user.id, emp_id: profile.emp_id, email: emailNorm,
        otp_hash: _otpHash(code), session: pendingSession,
        expires_at: new Date(Date.now() + OTP_TTL_MIN * 60 * 1000).toISOString(),
      }).select('id').single();
      if (pErr) { console.error('[otp] pending insert failed:', pErr.message); return res.status(500).json({ error: 'Could not start verification. Please try again.' }); }
      await _sendOtpEmail(emailNorm, profile.full_name, code);
      return res.json({ otp_required: true, pending_id: pend.id, email_masked: _maskEmail(emailNorm) });
    }
  }

  res.json({
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
    expires_at: data.session.expires_at,
    user: {
      id: data.user.id, email: data.user.email,
      role: profile.role || 'employee', emp_id: profile.emp_id, full_name: profile.full_name,
      must_change_password: profile.must_change_password ?? false,
    },
  });
});

// ─── POST /api/auth/refresh ───────────────────────────────────────────────────
router.post('/refresh', async (req, res) => {
  const { refresh_token } = req.body;
  if (!refresh_token) return res.status(400).json({ error: 'refresh_token required' });
  const { data, error } = await supabase.auth.refreshSession({ refresh_token });
  if (error) return res.status(401).json({ error: 'Session expired. Please log in again.' });
  res.json({
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
    expires_at: data.session.expires_at,
  });
});

// ─── POST /api/auth/logout ────────────────────────────────────────────────────
router.post('/logout', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const { data: { user } } = await supabase.auth.getUser(token);
    if (user)
      await supabase.auth.admin.signOut(token).catch(e => console.warn('[logout] signOut failed:', e.message));
  }
  res.json({ success: true });
});

// ─── GET /api/auth/enrollment-data ───────────────────────────────────────────
// Protected: fetch employee data + rate cards + existing dependents for GMC enrollment form.
//
// FIX: Wrapped Promise.all in try/catch so a Supabase error on ANY of the 5 queries
// (including the new employee_gmc_enrollment_insured fetch) cannot crash the handler
// silently and leave the browser hanging on "Submitting...".
// FIX: depsRes.error is now checked and logged separately — it never blocks the response.
router.get('/enrollment-data', requireAuth, enrollmentLimiter, async (req, res) => {
  const { emp_id, id: userId } = req.user;
  if (!emp_id) return res.status(400).json({ error: 'No emp_id linked to your account. Contact HR.' });

  // ── All data from employees table (canonical). No onboarding fallback. ────
  let empRes, rateRes, enrollRes, profileRes, depsRes, ctcTotalRes, eligRes;
  try {
    [empRes, rateRes, enrollRes, profileRes, depsRes, ctcTotalRes, eligRes] = await Promise.all([
      // 1. Employees — THE only source of employee data
      supabase.from('employees')
        .select('emp_id,emp_name,gender,date_of_birth,department,designation,date_of_joining,ctc_gmc_per_month,unit,gmc_inclusion_date,gmc_effective_date,email_id,is_active,status')
        .eq('emp_id', emp_id).single(),
      // 2. Rate cards for sum insured options
      supabase.from('gmc_premium_rates_26_27')
        .select('id,sum_insured,age_min,age_max,annual_premium')
        .order('sum_insured').order('age_min'),
      // 3. Existing enrollment draft
      supabase.from('employee_gmc_enrollment')
        .select('*').eq('emp_id', emp_id).order('created_at', { ascending: false }).limit(1),
      // 4. User profile for email
      supabase.from('user_profiles')
        .select('email, must_change_password').eq('id', userId).single(),
      // 5. Saved insured members
      supabase.from('employee_gmc_enrollment_insured')
        .select('*').eq('emp_id', emp_id),
      // 6. CTC GMC total from view — THE only source, no JS fallback
      supabase.from('vw_employee_ctc_gmc_total')
        .select('total_ctc_gmc').eq('emp_id', emp_id).single(),
      // 7. ENROLLMENT ELIGIBILITY — emp_id must be whitelisted for 2026-27
      supabase.from('enrollment_eligible_2026_27')
        .select('emp_id').eq('emp_id', emp_id).maybeSingle(),
    ]);
  } catch (err) {
    console.error('[enrollment-data] fetch error:', err.message);
    return res.status(500).json({ error: 'Failed to load enrollment data. Please refresh.' });
  }

  const emp = empRes?.data;
  if (!emp) return res.status(404).json({ error: 'Employee record not found. Please contact HR.' });
  if (!emp.is_active) return res.status(403).json({ error: 'Your account is inactive. Contact HR.' });

  // ── ENROLLMENT ELIGIBILITY GATE (2026-27) ───────────────────────────────
  // Only emp_ids listed in enrollment_eligible_2026_27 may open the enrollment.
  if (!eligRes?.data) {
    return res.status(403).json({
      error: 'You are not eligible for GMC Enrollment 2026-27. Please contact HR if you believe this is incorrect.',
      enrollment_eligible: false,
    });
  }

  // Track the page visit (non-fatal) — feeds vw_enrollment_progress
  try {
    const { data: mon } = await supabase.from('enrollment_monitor_2026_27')
      .select('page_visit_count').eq('emp_id', emp_id).maybeSingle();
    await supabase.from('enrollment_monitor_2026_27').upsert({
      emp_id,
      full_name: emp.emp_name,
      email_id: emp.email_id || null,
      visited_enrollment_page_at: new Date().toISOString(),
      page_visit_count: (mon?.page_visit_count || 0) + 1,
      last_logged_in_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'emp_id' });
  } catch (e) { console.warn('[enrollment-data] monitor upsert failed:', e.message); }

  if (depsRes?.error)
    console.warn('[enrollment-data] insured fetch error:', depsRes.error.message);

  const enrollmentDraft = enrollRes.data?.[0] || null;

  console.log(`[enrollment-data] emp_id=${emp_id} source=employees dob=${emp.date_of_birth} gmc_effective=${emp.gmc_effective_date}`);

  res.json({
    employee: {
      emp_id:             emp.emp_id,
      emp_name:           emp.emp_name,
      gender:             emp.gender,
      date_of_birth:      emp.date_of_birth,
      date_of_joining:    emp.date_of_joining,
      department:         emp.department,
      designation:        emp.designation,
      ctc_gmc_per_month:  emp.ctc_gmc_per_month,
      unit:               emp.unit,
      gmc_inclusion_date: emp.gmc_inclusion_date,
      gmc_effective_date: emp.gmc_effective_date,
      // email_id from employees table (HR uploaded)
      email_id:           emp.email_id || profileRes.data?.email || null,
      _source:            'employees',
    },
    rate_cards:          rateRes.data || [],
    enrollment:          enrollmentDraft,
    profile: {
      email: emp.email_id || profileRes.data?.email || enrollmentDraft?.email_id || null,
    },
    existing_dependents: depsRes?.data || [],
    // From vw_employee_ctc_gmc_total only — null = not on GMC yet (no proration fallback)
    ctc_gmc_total_from_view: ctcTotalRes?.data?.total_ctc_gmc ?? null,
    enrollment_eligible: true,
  });
});

// ─── POST /api/auth/enrollment ────────────────────────────────────────────────
// Protected: save or submit GMC enrollment.
//
// FIX: Replaced fragile res.status/res.json monkey-patching with a clean try/catch
// wrapping the entire handler body. The old override broke when Express's internal
// error handler called res.status(500).json() on an uncaught error, causing either
// a double-response or no response at all, leaving the browser stuck on "Submitting…".
router.post('/enrollment', requireAuth, enrollmentLimiter, async (req, res) => {
  const { emp_id } = req.user;
  if (!emp_id) return res.status(400).json({ error: 'No emp_id linked to your account.' });

  // Hard timeout: if DB takes more than 25s, send a clear 503 instead of letting
  // Render's load balancer silently drop the TCP connection.
  // The frontend's isTimeout path will then verify DB state and recover gracefully.
  let responded = false;
  const timeoutHandle = setTimeout(() => {
    if (!responded) {
      responded = true;
      console.error('[enrollment] handler timeout for emp_id:', emp_id);
      res.status(503).json({
        error: 'The server took too long to respond. Your data may have been saved — please refresh to check before trying again.',
        _timeout: true,
      });
    }
  }, 25000);

  // Helper to send a response and cancel the timeout atomically.
  // Always use this instead of res.json/res.status directly inside the handler.
  function send(statusCode, body) {
    if (responded) return; // timeout already fired — don't double-respond
    responded = true;
    clearTimeout(timeoutHandle);
    res.status(statusCode).json(body);
  }

  try {
    const { action, enrollment, insured_members, summary } = req.body;

    if (!['save', 'submit'].includes(action))
      return send(400, { error: 'action must be "save" or "submit"' });

    // ── ENROLLMENT ELIGIBILITY GATE (2026-27) ─────────────────────────────
    // Authoritative check — never trust the client to have hidden the page.
    const { data: eligRow } = await supabase
      .from('enrollment_eligible_2026_27').select('emp_id').eq('emp_id', emp_id).maybeSingle();
    if (!eligRow)
      return send(403, { error: 'You are not eligible for GMC Enrollment 2026-27. Please contact HR.' });
    if (!enrollment || typeof enrollment !== 'object')
      return send(400, { error: 'enrollment data is required' });

    // ── Lock check ───────────────────────────────────────────────────────────
    const { data: existing } = await supabase
      .from('employee_gmc_enrollment').select('enrollment_id, enrollment_status')
      .eq('emp_id', emp_id).order('created_at', { ascending: false }).limit(1).single();

    if (existing?.enrollment_status === 'APPROVED')
      return send(403, { error: 'Enrollment is already approved and locked.' });

    // ── Idempotent re-submit (Render cold-start / network retry scenario) ────
    // First request saved OK but the TCP response was dropped before reaching
    // the browser. fetchWithRetry fires again 2s later. Detect and return success.
    if (existing?.enrollment_status === 'SUBMITTED' && action === 'submit') {
      const { data: existingMembers } = await supabase
        .from('employee_gmc_enrollment_insured').select('*').eq('enrollment_id', existing.enrollment_id);
      // Only treat as an already-done resubmit if members were actually saved.
      // A SUBMITTED header with ZERO members means a previous attempt failed/partial —
      // fall through and (re)save the members instead of masking it as success.
      if (existingMembers && existingMembers.length > 0) {
        return send(200, {
          success: true,
          enrollment_id: existing.enrollment_id,
          status: 'SUBMITTED',
          insured_members: existingMembers,
          _retry: true,
        });
      }
    }

    const enrollmentStatus = action === 'submit' ? 'SUBMITTED' : 'DRAFT';
    const now = new Date().toISOString();

    // ── Build enrollment payload — emp_id always from JWT ────────────────────
    const enrollmentData = {
      ...enrollment,
      emp_id,                 // override — never trust client body
      enrollment_status: enrollmentStatus,
      updated_at: now,
      ...(action === 'submit' ? { submitted_at: now } : {}),
    };

    // Strip admin-only fields employees must never set
    delete enrollmentData.admin_remarks;
    delete enrollmentData.reviewed_by;
    delete enrollmentData.reviewed_at;
    delete enrollmentData.locked_at;
    delete enrollmentData.locked_by;

    // ── Upsert enrollment record ──────────────────────────────────────────────
    let enrollmentId;
    if (existing) {
      const { data: updated, error: upErr } = await supabase
        .from('employee_gmc_enrollment')
        .update(enrollmentData)
        .eq('enrollment_id', existing.enrollment_id)
        .select('enrollment_id').single();
      if (upErr) return send(400, { error: upErr.message });
      enrollmentId = updated.enrollment_id;
    } else {
      const { data: inserted, error: insErr } = await supabase
        .from('employee_gmc_enrollment')
        .insert({ ...enrollmentData, created_at: now })
        .select('enrollment_id').single();
      if (insErr) return send(400, { error: insErr.message });
      enrollmentId = inserted.enrollment_id;
    }

    // ── Save insured members — delete-then-insert for idempotency ────────────
    if (Array.isArray(insured_members) && enrollmentId) {
      if (insured_members.length > 0) {
        const membersToInsert = insured_members.map(m => ({
          ...m,
          enrollment_id: enrollmentId,
          emp_id,           // force from JWT
          created_at: now,
        }));
        membersToInsert.forEach(m => { delete m.insured_id; });

        // Delete ALL existing members first, then re-insert fresh.
        // This is idempotent: if the response was lost and the client retries,
        // we clear and re-write rather than attempting to diff.
        await supabase.from('employee_gmc_enrollment_insured')
          .delete().eq('enrollment_id', enrollmentId);

        const { error: membInsErr } = await supabase
          .from('employee_gmc_enrollment_insured').insert(membersToInsert);
        if (membInsErr) {
          console.error('[enrollment] insured_members insert failed:', membInsErr.message);
          // Don't leave a SUBMITTED header with no members — revert to DRAFT so the
          // next submit retries the member insert instead of short-circuiting.
          await supabase.from('employee_gmc_enrollment')
            .update({ enrollment_status: 'DRAFT', submitted_at: null })
            .eq('enrollment_id', enrollmentId);
          // RECOVERY: store the full submitted payload in the audit table so the
          // member data the employee entered is never lost even if the insert fails.
          try {
            await supabase.from('employee_gmc_enrollment_audit').insert({
              enrollment_id: enrollmentId, emp_id, action: 'SUBMIT_FAILED', action_by: emp_id,
              remarks: ('insured insert failed: ' + membInsErr.message).slice(0, 500),
              payload: { enrollment: enrollmentData, insured_members }, created_at: now,
            });
          } catch (e) { console.warn('[enrollment] failure-audit insert failed:', e.message); }
          return send(400, { error: 'Failed to save insured members: ' + membInsErr.message });
        }
      } else {
        // Empty array = remove all members
        await supabase.from('employee_gmc_enrollment_insured')
          .delete().eq('enrollment_id', enrollmentId);
      }
    }

    // ── Save summary (non-fatal) ──────────────────────────────────────────────
    // NOTE: supabase-js query builders are PromiseLike (then only) — they have NO
    // .catch(). Calling .catch() on them throws a TypeError. Always use try/catch.
    if (summary && enrollmentId) {
      try {
        const { error: sumErr } = await supabase.from('employee_gmc_enrollment_summary').upsert(
          { ...summary, enrollment_id: enrollmentId, emp_id, calculated_at: now },
          { onConflict: 'enrollment_id' }
        );
        if (sumErr) console.warn('[enrollment] summary upsert failed:', sumErr.message);
      } catch (e) { console.warn('[enrollment] summary upsert threw:', e.message); }
    }

    // ── Audit trail (non-fatal) ───────────────────────────────────────────────
    try {
      const { error: audErr } = await supabase.from('employee_gmc_enrollment_audit').insert({
        enrollment_id: enrollmentId, emp_id,
        action: action === 'submit' ? 'SUBMIT' : 'DRAFT_SAVE',
        action_by: emp_id, created_at: now,
        payload: { enrollment: enrollmentData, insured_members: insured_members || [] },
      });
      if (audErr) console.warn('[enrollment] audit insert failed:', audErr.message);
    } catch (e) { console.warn('[enrollment] audit insert threw:', e.message); }

    // ── Fetch fresh insured_members for response ──────────────────────────────
    // Return the DB-confirmed list so the frontend doesn't need a separate re-fetch.
    const { data: freshMembers } = await supabase
      .from('employee_gmc_enrollment_insured').select('*').eq('enrollment_id', enrollmentId);

    // Track progress (non-fatal) — feeds vw_enrollment_progress
    try {
      const { data: mon } = await supabase.from('enrollment_monitor_2026_27')
        .select('submission_attempt_count').eq('emp_id', emp_id).maybeSingle();
      await supabase.from('enrollment_monitor_2026_27').upsert({
        emp_id,
        enrollment_id: enrollmentId,
        submission_attempt_count: (mon?.submission_attempt_count || 0) + 1,
        ...(action === 'submit' ? { submitted_at: now } : {}),
        updated_at: now,
      }, { onConflict: 'emp_id' });
    } catch (e) { console.warn('[enrollment] monitor upsert failed:', e.message); }

    send(200, {
      success: true,
      enrollment_id: enrollmentId,
      status: enrollmentStatus,
      insured_members: freshMembers || [],
    });

  } catch (err) {
    // Catch any unexpected throw (e.g. Supabase client network error, JSON parse fail).
    // Without this, Express would send a 500 HTML error page through its own handler,
    // bypassing our timeout guard and leaving the browser with no parseable response.
    console.error('[enrollment] unexpected error for emp_id:', emp_id, '|', err.message);
    send(500, { error: 'An unexpected error occurred. Please refresh and try again.' });
  }
});

// ─── POST /api/auth/simple-signup ─────────────────────────────────────────────
// Public: Simplified employee self-registration — no FK check, direct onboarding insert.
router.post('/simple-signup', authLimiter, async (req, res) => {
  const {
    emp_id, emp_name, email, password, captchaToken,
    gender, date_of_birth, date_of_joining,
    department, designation, mobile_number, ctc_gmc_per_month, unit,
  } = req.body;

  if (!emp_id || !emp_name || !email || !password)
    return res.status(400).json({ error: 'emp_id, emp_name, email, and password are required' });
  const emailErr = validateEmail(email);
  if (emailErr) return res.status(400).json({ error: emailErr });
  const pwErr = validatePassword(password);
  if (pwErr) return res.status(400).json({ error: pwErr });

  const captchaResult = await verifyCaptcha(captchaToken, req.ip);
  if (!captchaResult.success) return res.status(400).json({ error: captchaResult.error });

  const empIdNorm = emp_id.trim().toUpperCase();
  const emailNorm = email.trim().toLowerCase();
  const dobNorm   = normalizeDateForPg(date_of_birth);
  const dojNorm   = normalizeDateForPg(date_of_joining);

  const [profileByEmpId, profileByEmail] = await Promise.all([
    supabase.from('user_profiles').select('id').eq('emp_id', empIdNorm).single(),
    supabase.from('user_profiles').select('id').eq('email', emailNorm).single(),
  ]);
  if (profileByEmpId.data)
    return res.status(409).json({ error: 'An account already exists for this Employee ID. Please sign in.' });
  if (profileByEmail.data)
    return res.status(409).json({ error: 'This email is already registered. Please sign in.' });

  const { data: authData, error: authErr } = await supabase.auth.admin.createUser({
    email: emailNorm, password, email_confirm: true,
    user_metadata: { full_name: emp_name, emp_id: empIdNorm, role: 'employee' },
  });
  if (authErr) {
    const { status, error } = friendlyAuthError(authErr, 'simple-signup');
    return res.status(status).json({ error });
  }

  const { error: profileErr } = await supabase.from('user_profiles').upsert({
    id: authData.user.id, email: emailNorm, full_name: emp_name,
    emp_id: empIdNorm, role: 'employee', is_active: true,
  }, { onConflict: 'id' });
  if (profileErr)
    console.error('[simple-signup] user_profiles upsert failed for', empIdNorm,
      '| code:', profileErr.code, '| msg:', profileErr.message);

  const { data: existingOnboarding } = await supabase
    .from('employee_onboarding').select('emp_id').eq('emp_id', empIdNorm).single();

  if (!existingOnboarding) {
    const onboardingPayload = {
      emp_id: empIdNorm, emp_name, gender: gender || null,
      date_of_birth: dobNorm || null, date_of_joining: dojNorm || null,
      department: department || null, designation: designation || null,
      mobile_number: mobile_number || null, email_id: emailNorm, unit: unit || null,
      ctc_gmc_per_month: ctc_gmc_per_month != null ? Number(ctc_gmc_per_month) : null,
      onboarding_status: 'pending',
    };
    const { error: obErr } = await supabase.from('employee_onboarding').insert(onboardingPayload);
    if (obErr && !isDuplicateKeyError(obErr))
      console.error('[simple-signup] employee_onboarding insert failed for', empIdNorm, ':', obErr.message);
  }

  console.log('[simple-signup] account created for', empIdNorm, '/', emailNorm);
  res.status(201).json({ message: 'Account created successfully! You can now sign in.' });
});

// ─── PATCH /api/auth/update-ctc ──────────────────────────────────────────────
// Protected: Employee updates their own ctc_gmc_per_month.
// Writes to BOTH tables so the value is consistent regardless of which source
// the enrollment-data endpoint picks up (employees takes priority).
router.patch('/update-ctc', requireAuth, async (req, res) => {
  const { emp_id } = req.user;
  if (!emp_id) return res.status(400).json({ error: 'No emp_id on account.' });

  const { ctc_gmc_per_month } = req.body;
  if (ctc_gmc_per_month === undefined || ctc_gmc_per_month === null || isNaN(Number(ctc_gmc_per_month)))
    return res.status(400).json({ error: 'ctc_gmc_per_month must be a number.' });

  const ctcVal = Number(ctc_gmc_per_month);
  if (ctcVal < 0) return res.status(400).json({ error: 'CTC GMC cannot be negative.' });

  // Update both tables in parallel — ignore "no rows matched" (employee may only exist in one)
  const [empRes, obRes] = await Promise.all([
    supabase.from('employees').update({ ctc_gmc_per_month: ctcVal }).eq('emp_id', emp_id),
    supabase.from('employee_onboarding').update({ ctc_gmc_per_month: ctcVal }).eq('emp_id', emp_id),
  ]);

  // Only fail hard if BOTH writes errored (genuine DB error, not "row not found")
  const empErr = empRes.error;
  const obErr  = obRes.error;
  if (empErr && obErr) {
    console.error('[update-ctc] both writes failed for', emp_id, ':', empErr.message, obErr.message);
    return res.status(400).json({ error: empErr.message || obErr.message });
  }
  if (empErr)  console.warn('[update-ctc] employees write failed for', emp_id, ':', empErr.message);
  if (obErr)   console.warn('[update-ctc] employee_onboarding write failed for', emp_id, ':', obErr.message);

  console.log('[update-ctc] emp_id', emp_id, 'set ctc_gmc_per_month =', ctcVal);
  res.json({ success: true, ctc_gmc_per_month: ctcVal });
});

// ─── GET /api/auth/me ─────────────────────────────────────────────────────────
router.get('/me', requireAuth, async (req, res) => {
  const { id: userId } = req.user;
  const { data: profile, error } = await supabase
    .from('user_profiles').select('role, emp_id, full_name, is_active, email, must_change_password').eq('id', userId).single();
  if (error || !profile) return res.status(401).json({ error: 'Profile not found.' });
  if (!profile.is_active) return res.status(403).json({ error: 'Account is deactivated.' });
  res.json({ user: { id: userId, ...profile } });
});

// ─── POST /api/auth/forgot-password ──────────────────────────────────────────
// Public: employee enters their email, receives a one-time reset token.
// Backend sends email via Supabase auth's built-in password reset email
// (uses Supabase SMTP settings — no extra SMTP config needed).
router.post('/forgot-password', authLimiter, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required.' });

  const emailNorm = email.trim().toLowerCase();

  // Verify the email belongs to an employee (don't leak which emails exist)
  const { data: profile } = await supabase
    .from('user_profiles').select('id, is_active').eq('email', emailNorm).single();

  // Always respond success to prevent email enumeration attacks
  if (!profile || !profile.is_active) {
    return res.json({ success: true, message: 'If this email is registered, a reset link has been sent.' });
  }

  // Use Supabase built-in password reset (sends email via your Supabase SMTP config)
  const { error } = await supabase.auth.resetPasswordForEmail(emailNorm, {
    redirectTo: `${process.env.FRONTEND_URL || 'https://gcpl.insurance-portal.in'}/reset-password`,
  });

  if (error) {
    console.error('[forgot-password] Supabase error:', error.message);
    // Don't expose internal errors — return generic success
  }

  res.json({ success: true, message: 'If this email is registered, a reset link has been sent.' });
});

// ─── POST /api/auth/change-password ──────────────────────────────────────────
// Protected: authenticated employee changes their own password.
// Clears must_change_password flag on success.
router.post('/change-password', requireAuth, async (req, res) => {
  const { id: userId, emp_id } = req.user;
  const { current_password, new_password } = req.body;

  if (!current_password || !new_password)
    return res.status(400).json({ error: 'current_password and new_password are required.' });

  const pwErr = validatePassword(new_password);
  if (pwErr) return res.status(400).json({ error: pwErr });

  if (current_password === new_password)
    return res.status(400).json({ error: 'New password must be different from your current password.' });

  // Verify current password by attempting re-authentication
  const { data: userCheck } = await supabase.auth.admin.getUserById(userId);
  const userEmail = userCheck?.user?.email;
  if (!userEmail) return res.status(400).json({ error: 'Could not verify identity.' });

  const { error: verifyErr } = await supabase.auth.signInWithPassword({
    email: userEmail, password: current_password,
  });
  if (verifyErr)
    return res.status(401).json({ error: 'Current password is incorrect.' });

  // Update password
  const { error: updateErr } = await supabase.auth.admin.updateUserById(userId, {
    password: new_password,
  });
  if (updateErr) {
    console.error('[change-password] update failed:', updateErr.message);
    return res.status(400).json({ error: 'Password update failed. Please try again.' });
  }

  // Clear must_change_password flag
  await supabase.from('user_profiles')
    .update({ must_change_password: false })
    .eq('id', userId);

  console.log('[change-password] emp_id', emp_id, 'changed password successfully');
  res.json({ success: true, message: 'Password changed successfully.' });
});

// ─── OTP verify / resend ────────────────────────────────────────────────────────
router.post('/verify-otp', authLimiter, async (req, res) => {
  const { pending_id, code, remember_device } = req.body || {};
  if (!pending_id || !code) return res.status(400).json({ error: 'Code is required.' });

  const { data: pend } = await supabase.from('login_otp_pending').select('*').eq('id', pending_id).single();
  if (!pend) return res.status(400).json({ error: 'Verification expired. Please log in again.' });
  if (new Date(pend.expires_at) < new Date()) {
    await supabase.from('login_otp_pending').delete().eq('id', pending_id);
    return res.status(400).json({ error: 'Code expired. Please log in again.' });
  }
  if (pend.attempts >= OTP_MAX_ATTEMPTS) {
    await supabase.from('login_otp_pending').delete().eq('id', pending_id);
    return res.status(429).json({ error: 'Too many incorrect attempts. Please log in again.' });
  }
  if (_otpHash(String(code).trim()) !== pend.otp_hash) {
    await supabase.from('login_otp_pending').update({ attempts: pend.attempts + 1 }).eq('id', pending_id);
    const left = Math.max(0, OTP_MAX_ATTEMPTS - (pend.attempts + 1));
    return res.status(401).json({ error: `Incorrect code. ${left} attempt(s) left.` });
  }

  await supabase.from('login_otp_pending').delete().eq('id', pending_id);
  let device_token = null;
  if (remember_device) {
    device_token = _genDevice();
    await supabase.from('trusted_device').insert({
      user_id: pend.user_id, emp_id: pend.emp_id, token_hash: _tokenHash(device_token),
      user_agent: (req.headers['user-agent'] || '').toString().slice(0, 300),
      expires_at: new Date(Date.now() + DEVICE_TRUST_DAYS * 86400 * 1000).toISOString(),
    });
  }
  return res.json({ ...(pend.session || {}), device_token });
});

router.post('/resend-otp', authLimiter, async (req, res) => {
  const { pending_id } = req.body || {};
  if (!pending_id) return res.status(400).json({ error: 'Session expired. Please log in again.' });
  const { data: pend } = await supabase.from('login_otp_pending').select('*').eq('id', pending_id).single();
  if (!pend) return res.status(400).json({ error: 'Session expired. Please log in again.' });
  if (new Date(pend.expires_at) < new Date()) return res.status(400).json({ error: 'Session expired. Please log in again.' });
  if (pend.resend_count >= OTP_MAX_RESENDS) return res.status(429).json({ error: 'Resend limit reached. Please log in again.' });
  if (Date.now() - new Date(pend.last_sent_at).getTime() < OTP_RESEND_COOLDOWN_MS)
    return res.status(429).json({ error: 'Please wait a minute before requesting another code.' });
  const code = _genOtp();
  await supabase.from('login_otp_pending').update({
    otp_hash: _otpHash(code), last_sent_at: new Date().toISOString(),
    resend_count: pend.resend_count + 1, attempts: 0,
  }).eq('id', pending_id);
  await _sendOtpEmail(pend.email, null, code);
  return res.json({ ok: true, email_masked: _maskEmail(pend.email) });
});

export default router;
