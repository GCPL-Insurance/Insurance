import { Router } from 'express';
import { supabase } from '../index.js';
import { requireAuth } from '../index.js';
import { authLimiter, enrollmentLimiter } from '../limiters.js';

const router = Router();

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

  const { data: empRecord } = await supabase
    .from('employee_onboarding')
    .select('emp_id, emp_name, department, designation, date_of_joining, gender, date_of_birth, onboarding_status')
    .eq('emp_id', empIdNorm).single();

  let empFallback = null;
  if (!empRecord) {
    const { data } = await supabase
      .from('employees')
      .select('emp_id, emp_name, department, designation, date_of_joining, gender, date_of_birth, is_active')
      .eq('emp_id', empIdNorm).single();
    empFallback = data;
  }

  const source = empRecord || empFallback;

  res.json({
    verified: true,
    emp_id: empIdNorm,
    from_onboarding_table: !!empRecord,
    from_employees_table: !!empFallback,
    emp_name: source?.emp_name || null,
    department: source?.department || null,
    designation: source?.designation || null,
    date_of_joining: source?.date_of_joining || null,
    gender: source?.gender || null,
    date_of_birth: source?.date_of_birth || null,
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

  await supabase.from('employees').update({ auth_uid: authData.user.id }).eq('emp_id', emp.emp_id)
    .catch(e => console.warn('[signup] auth_uid link failed:', e.message));

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
router.post('/login', authLimiter, async (req, res) => {
  const { email, password, captchaToken } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const captchaResult = await verifyCaptcha(captchaToken, req.ip);
  if (!captchaResult.success) return res.status(400).json({ error: captchaResult.error });

  const { data, error } = await supabase.auth.signInWithPassword({
    email: email.trim().toLowerCase(), password,
  });
  if (error) {
    console.warn('[login] failed for', email.trim().toLowerCase(), ':', error.message);
    return res.status(401).json({ error: 'Invalid email or password.' });
  }

  const { data: profile, error: profileErr } = await supabase
    .from('user_profiles').select('role, emp_id, full_name, is_active').eq('id', data.user.id).single();

  if (profileErr || !profile)
    return res.status(401).json({ error: 'Account not fully set up. Please contact admin.' });
  if (!profile.is_active) {
    await supabase.auth.admin.signOut(data.session.access_token).catch(() => {});
    return res.status(403).json({ error: 'Account is deactivated. Contact admin.' });
  }

  res.json({
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
    expires_at: data.session.expires_at,
    user: {
      id: data.user.id, email: data.user.email,
      role: profile.role || 'employee', emp_id: profile.emp_id, full_name: profile.full_name,
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

  // ── Fetch all data in parallel ────────────────────────────────────────────
  // IMPORTANT: Promise.all is wrapped in try/catch. Before this fix, an unhandled
  // rejection here (e.g. RLS block on employee_gmc_enrollment_insured) would crash
  // Express mid-request and send NO response, freezing the UI on "Submitting…".
  let empRes, rateRes, enrollRes, profileRes, depsRes;
  try {
    [empRes, rateRes, enrollRes, profileRes, depsRes] = await Promise.all([
      supabase.from('employee_onboarding')
        .select('emp_id,emp_name,gender,date_of_birth,department,designation,date_of_joining,ctc_gmc_per_month,onboarding_status,mobile_number,email_id,unit')
        .eq('emp_id', emp_id).single(),
      supabase.from('gmc_rate_cards')
        .select('rate_card_id,rate_card_type,age_band_from,age_band_to,sum_insured,annual_premium')
        .eq('rate_card_type', 'INSURER').order('sum_insured').order('age_band_from'),
      supabase.from('employee_gmc_enrollment')
        .select('*').eq('emp_id', emp_id).order('created_at', { ascending: false }).limit(1),
      supabase.from('user_profiles')
        .select('email').eq('id', userId).single(),
      // NOTE: This query was added 2 days ago. If the table has no RLS SELECT policy
      // for the employee role, Supabase returns an error object (not an exception).
      // We handle it below with a separate depsRes.error check so it never crashes.
      supabase.from('employee_gmc_enrollment_insured')
        .select('*').eq('emp_id', emp_id),
    ]);
  } catch (err) {
    // Should not happen with Supabase client (it resolves errors, not rejects),
    // but guard anyway against any unexpected network-level throw.
    console.error('[enrollment-data] Promise.all threw unexpectedly:', err.message);
    return res.status(500).json({ error: 'Failed to load enrollment data. Please refresh and try again.' });
  }

  // Log RLS/permission errors on the insured table without crashing the response.
  // ACTION REQUIRED: If you see this log, add a SELECT RLS policy on
  // employee_gmc_enrollment_insured allowing employees to read rows where emp_id matches.
  if (depsRes?.error) {
    console.error('[enrollment-data] employee_gmc_enrollment_insured query failed:',
      depsRes.error.message, '| code:', depsRes.error.code,
      '| hint: add RLS SELECT policy for employee role on this table');
  }

  // ── Resolve employee record with fallback chain ───────────────────────────
  let employeeData = empRes.data;

  if (!employeeData && enrollRes.data?.[0]) {
    const e = enrollRes.data[0];
    employeeData = {
      emp_id: e.emp_id, emp_name: e.emp_name, gender: e.gender,
      date_of_birth: e.date_of_birth, department: e.department,
      designation: e.designation, date_of_joining: e.date_of_joining,
      ctc_gmc_per_month: e.ctc_gmc_per_month, onboarding_status: 'pending',
      _is_new_employee: true,
    };
  }

  if (!employeeData) {
    const { data: profileFallback } = await supabase
      .from('user_profiles').select('emp_id, full_name, email').eq('id', userId).single();
    if (profileFallback?.emp_id) {
      employeeData = {
        emp_id: profileFallback.emp_id,
        emp_name: profileFallback.full_name || profileFallback.emp_id,
        gender: null, date_of_birth: null, department: null,
        designation: null, date_of_joining: null,
        ctc_gmc_per_month: 0, onboarding_status: 'pending',
        _is_new_employee: true,
        _profile_only: true,
      };
    } else {
      return res.status(404).json({ error: 'Employee record not found. Please contact HR.' });
    }
  }

  const enrollmentDraft = enrollRes.data?.[0] || null;

  res.json({
    employee: employeeData,
    rate_cards: rateRes.data || [],
    enrollment: enrollmentDraft,
    profile: {
      mobile_number: empRes.data?.mobile_number || enrollmentDraft?.mobile_number || null,
      email:         empRes.data?.email_id       || profileRes.data?.email         || enrollmentDraft?.email_id || null,
    },
    // Returns [] on RLS error so the form still loads — employee can re-add dependents.
    // Fix the RLS policy in Supabase to restore pre-population of saved dependents.
    existing_dependents: depsRes?.data || [],
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
      return send(200, {
        success: true,
        enrollment_id: existing.enrollment_id,
        status: 'SUBMITTED',
        insured_members: existingMembers || [],
        _retry: true,
      });
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
          return send(400, { error: 'Failed to save insured members: ' + membInsErr.message });
        }
      } else {
        // Empty array = remove all members
        await supabase.from('employee_gmc_enrollment_insured')
          .delete().eq('enrollment_id', enrollmentId);
      }
    }

    // ── Save summary (non-fatal) ──────────────────────────────────────────────
    if (summary && enrollmentId) {
      await supabase.from('employee_gmc_enrollment_summary').upsert(
        { ...summary, enrollment_id: enrollmentId, emp_id, calculated_at: now },
        { onConflict: 'enrollment_id' }
      ).catch(e => console.warn('[enrollment] summary upsert failed:', e.message));
    }

    // ── Audit trail (non-fatal) ───────────────────────────────────────────────
    await supabase.from('employee_gmc_enrollment_audit').insert({
      enrollment_id: enrollmentId, emp_id,
      action: action === 'submit' ? 'SUBMIT' : 'DRAFT_SAVE',
      action_by: emp_id, created_at: now,
    }).catch(e => console.warn('[enrollment] audit insert failed:', e.message));

    // ── Fetch fresh insured_members for response ──────────────────────────────
    // Return the DB-confirmed list so the frontend doesn't need a separate re-fetch.
    const { data: freshMembers } = await supabase
      .from('employee_gmc_enrollment_insured').select('*').eq('enrollment_id', enrollmentId);

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
// Protected: Employee updates their own ctc_gmc_per_month in employee_onboarding.
router.patch('/update-ctc', requireAuth, async (req, res) => {
  const { emp_id } = req.user;
  if (!emp_id) return res.status(400).json({ error: 'No emp_id on account.' });

  const { ctc_gmc_per_month } = req.body;
  if (ctc_gmc_per_month === undefined || ctc_gmc_per_month === null || isNaN(Number(ctc_gmc_per_month)))
    return res.status(400).json({ error: 'ctc_gmc_per_month must be a number.' });

  const ctcVal = Number(ctc_gmc_per_month);
  if (ctcVal < 0) return res.status(400).json({ error: 'CTC GMC cannot be negative.' });

  const { error } = await supabase
    .from('employee_onboarding').update({ ctc_gmc_per_month: ctcVal }).eq('emp_id', emp_id);

  if (error) {
    console.error('[update-ctc] failed for', emp_id, ':', error.message);
    return res.status(400).json({ error: error.message });
  }

  console.log('[update-ctc] emp_id', emp_id, 'set ctc_gmc_per_month =', ctcVal);
  res.json({ success: true, ctc_gmc_per_month: ctcVal });
});

// ─── GET /api/auth/me ─────────────────────────────────────────────────────────
// Protected: validate token and return fresh user data.
router.get('/me', requireAuth, async (req, res) => {
  const { id: userId } = req.user;
  const { data: profile, error } = await supabase
    .from('user_profiles').select('role, emp_id, full_name, is_active, email').eq('id', userId).single();
  if (error || !profile) return res.status(401).json({ error: 'Profile not found.' });
  if (!profile.is_active) return res.status(403).json({ error: 'Account is deactivated.' });
  res.json({ user: { id: userId, ...profile } });
});

export default router;
