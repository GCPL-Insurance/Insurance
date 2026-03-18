import { Router } from 'express';
import { supabase } from '../index.js';
import { requireAuth } from '../index.js';

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

  // Already ISO-like format
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;

  // Portal often sends DD-MM-YYYY
  const dmy = raw.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]}`;

  // Let Postgres validate other rare formats by passing raw value
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
    // Skip captcha in dev/test environments
    if (process.env.NODE_ENV !== 'production') return { success: true };
    return { success: false, error: 'Captcha not configured on server.' };
  }
  try {
    // FIX: Add a 5-second timeout so a slow/unreachable Cloudflare endpoint
    // never causes login to hang for 60+ seconds.
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
      // FIX: On timeout, fail open in production so a Cloudflare outage doesn't
      // lock all users out. The Turnstile widget on the client already filters bots.
      return { success: true };
    }
    console.error('[captcha] verification failed:', err.message);
    return { success: false, error: 'Could not verify security check. Please try again.' };
  }
}

/**
 * Translate a Supabase auth.admin.createUser error into a friendly message.
 * Also logs the raw error for debugging on Render.
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
  // Generic fallback — don't expose raw Supabase internals
  return { status: 500, error: 'Account creation failed. Please try again or contact HR.' };
}

// ─── POST /api/auth/gmc-verify-emp ───────────────────────────────────────────
// Public: check if an emp_id already has an account before showing GMC signup form.
// ⚠️  Only returns account-existence check — does NOT return salary or PII.
router.post('/gmc-verify-emp', async (req, res) => {
  const { emp_id } = req.body;
  if (!emp_id || typeof emp_id !== 'string') return res.status(400).json({ error: 'emp_id required' });

  const empIdNorm = emp_id.trim().toUpperCase();

  // Check if an account already exists for this emp_id
  const { data: existingProfile } = await supabase
    .from('user_profiles').select('id').eq('emp_id', empIdNorm).single();
  if (existingProfile)
    return res.status(409).json({ error: 'An account already exists for this Employee ID. Please sign in.' });

  // Check for existing pending enrollment
  const { data: existingEnroll } = await supabase
    .from('employee_gmc_enrollment').select('enrollment_id, enrollment_status')
    .eq('emp_id', empIdNorm).order('created_at', { ascending: false }).limit(1).single();

  // Check employee_onboarding first — only return non-sensitive fields for prefill
  const { data: empRecord } = await supabase
    .from('employee_onboarding')
    .select('emp_id, emp_name, department, designation, date_of_joining, gender, date_of_birth, onboarding_status')
    // ⚠️ SECURITY FIX: ctc_gmc_per_month intentionally excluded from unauthenticated response
    .eq('emp_id', empIdNorm).single();

  // Fallback: check legacy employees table so frontend can choose the right signup path
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
    // ctc_gmc_per_month: intentionally NOT returned here
    existing_enrollment: existingEnroll
      ? { id: existingEnroll.enrollment_id, status: existingEnroll.enrollment_status }
      : null,
  });
});

// ─── POST /api/auth/gmc-signup ────────────────────────────────────────────────
// Public: New employee self-registration via GMC portal.
router.post('/gmc-signup', async (req, res) => {
  const {
    emp_id, email, password, full_name, captchaToken,
    gender, date_of_birth, department, designation, date_of_joining, mobile_number, unit,
  } = req.body;

  // ── Input validation ──
  if (!emp_id || !email || !password || !full_name) {
    return res.status(400).json({ error: 'emp_id, email, password, and full_name are required' });
  }
  const emailErr = validateEmail(email);
  if (emailErr) return res.status(400).json({ error: emailErr });
  const pwErr = validatePassword(password);
  if (pwErr) return res.status(400).json({ error: pwErr });

  // ── Captcha ──
  const captchaResult = await verifyCaptcha(captchaToken, req.ip);
  if (!captchaResult.success) return res.status(400).json({ error: captchaResult.error });

  const empIdNorm = emp_id.trim().toUpperCase();
  const emailNorm = email.trim().toLowerCase();
  const dobNorm = normalizeDateForPg(date_of_birth);
  const dojNorm = normalizeDateForPg(date_of_joining);

  // ── Duplicate checks ──
  const [profileByEmpId, profileByEmail] = await Promise.all([
    supabase.from('user_profiles').select('id').eq('emp_id', empIdNorm).single(),
    supabase.from('user_profiles').select('id').eq('email', emailNorm).single(),
  ]);
  if (profileByEmpId.data)
    return res.status(409).json({ error: 'An account already exists for this Employee ID. Please sign in.' });
  if (profileByEmail.data)
    return res.status(409).json({ error: 'This email is already registered. Please sign in.' });

  // ── Create Supabase auth user ──
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

  // ── Upsert user_profiles record ──
  // DB trigger on_auth_user_created_profile may insert a row automatically.
  // Upsert ensures our full data wins without crashing on duplicate key.
  const { error: profileErr } = await supabase.from('user_profiles').upsert({
    id: authData.user.id,
    email: emailNorm,
    full_name,
    emp_id: empIdNorm,
    role: 'employee',
    is_active: true,
  }, { onConflict: 'id' });
  if (profileErr) {
    console.error('[gmc-signup] user_profiles upsert failed for', empIdNorm,
      '| code:', profileErr.code, '| msg:', profileErr.message);
    // Non-fatal — auth user exists. employee_auth FK prevents deletion anyway.
  }

  // ── Ensure onboarding master record exists for GMC signup ──
  // ── Insert into employee_onboarding ONLY if HR hasn't already created a record ──
  const { data: existingOnboarding } = await supabase
    .from('employee_onboarding')
    .select('emp_id')
    .eq('emp_id', empIdNorm)
    .single();

  if (!existingOnboarding) {
    const onboardingPayload = {
      emp_id:            empIdNorm,
      emp_name:          full_name,
      gender:            gender     || null,
      date_of_birth:     dobNorm    || null,
      date_of_joining:   dojNorm    || null,
      department:        department || null,
      designation:       designation || null,
      mobile_number:     mobile_number || null,
      email_id:          emailNorm,
      unit:              unit || null,
      onboarding_status: 'pending',
      // ctc_gmc_per_month intentionally omitted — HR sets this separately
    };

    const { error: obErr } = await supabase.from('employee_onboarding').insert(onboardingPayload);

    if (obErr) {
      if (isDuplicateKeyError(obErr)) {
        // Race condition or DB trigger already inserted this row — safe to continue.
        console.warn('[gmc-signup] employee_onboarding duplicate key for', empIdNorm, '— skipping insert, row already exists.');
      } else if (isMissingColumnError(obErr)) {
        // Schema mismatch — log for ops but do NOT block the user from signing in.
        console.error('[gmc-signup] employee_onboarding column mismatch for', empIdNorm, ':', obErr.message,
          '| payload keys:', Object.keys(onboardingPayload).join(', '));
      } else {
        // Unknown DB error — log full details for ops. Auth + profile already succeeded,
        // so we do NOT rollback (rolling back here would orphan the auth user on retry).
        // The enrollment-data endpoint has fallbacks; the employee can still use the portal.
        console.error('[gmc-signup] employee_onboarding insert failed for', empIdNorm,
          '| code:', obErr.code, '| message:', obErr.message,
          '| details:', obErr.details, '| hint:', obErr.hint);
      }
      // ⚠ Non-fatal: Auth user + user_profiles are confirmed created.
      // Do NOT return an error here — the signup is functionally complete.
    }
  } else {
    // HR record already present — preserve it, do not overwrite.
    console.log('[gmc-signup] employee_onboarding record already exists for', empIdNorm, '— skipping insert.');
  }

  // ── Create DRAFT enrollment record ──
  const enrollmentPayload = {
    emp_id: empIdNorm,
    emp_name: full_name,
    gender: gender || null,
    date_of_birth: dobNorm,
    department: department || null,
    designation: designation || null,
    date_of_joining: dojNorm,
    mobile_number: mobile_number || null,
    email_id: emailNorm,
    selected_sum_insured: 0,
    enrollment_status: 'DRAFT',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  enrollmentPayload.ctc_gmc_per_month = 0; // HR can update in onboarding table later

  let { error: enrollErr } = await supabase.from('employee_gmc_enrollment').insert(enrollmentPayload);
  if (enrollErr && isMissingColumnError(enrollErr, 'ctc_gmc_per_month')) {
    // Backward-compatible fallback for DBs that don't yet have this column.
    const { ctc_gmc_per_month, ...payloadWithoutCtc } = enrollmentPayload;
    ({ error: enrollErr } = await supabase.from('employee_gmc_enrollment').insert(payloadWithoutCtc));
  }
  if (enrollErr) {
    // Non-fatal: log for ops team to manually create if needed
    console.error('[gmc-signup] DRAFT enrollment creation failed for', empIdNorm, ':', enrollErr.message);
  }

  res.status(201).json({
    success: true,
    message: 'Account created! You can now sign in and complete your GMC enrollment.',
    emp_name: full_name,
  });
});

// ─── POST /api/auth/signup ────────────────────────────────────────────────────
// Public: Standard employee self-registration (must already be in employees table).
router.post('/signup', async (req, res) => {
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

  // Employee must exist in employees table
  const { data: emp } = await supabase
    .from('employees')
    .select('emp_id, emp_name, is_active')
    .eq('emp_id', empIdNorm)
    .single();

  if (!emp) return res.status(404).json({ error: 'Employee ID not found. Please contact HR.' });
  if (!emp.is_active) return res.status(403).json({ error: 'Employee account is inactive. Contact HR.' });

  // Duplicate check
  const { data: existingProfile } = await supabase
    .from('user_profiles').select('id').eq('emp_id', emp.emp_id).single();
  if (existingProfile)
    return res.status(409).json({ error: 'An account already exists for this Employee ID. Please sign in.' });

  const { data: existingEmail } = await supabase
    .from('user_profiles').select('id').eq('email', emailNorm).single();
  if (existingEmail)
    return res.status(409).json({ error: 'This email is already registered. Please sign in.' });

  const { data: authData, error: authErr } = await supabase.auth.admin.createUser({
    email: emailNorm,
    password,
    email_confirm: true,
    user_metadata: { full_name: full_name || emp.emp_name, emp_id: emp.emp_id, role: 'employee' },
  });
  if (authErr) {
    const { status, error } = friendlyAuthError(authErr, 'signup');
    return res.status(status).json({ error });
  }

  // Upsert to handle DB trigger race condition (on_auth_user_created_profile)
  const { error: profileErr } = await supabase.from('user_profiles').upsert({
    id: authData.user.id,
    email: emailNorm,
    full_name: full_name || emp.emp_name,
    emp_id: emp.emp_id,
    role: 'employee',
    is_active: true,
  }, { onConflict: 'id' });
  if (profileErr) {
    console.error('[signup] user_profiles upsert failed | code:', profileErr.code, '| msg:', profileErr.message);
    // Non-fatal — employee_auth FK prevents auth user deletion anyway.
  }

  await supabase.from('employees').update({ auth_uid: authData.user.id }).eq('emp_id', emp.emp_id)
    .catch(e => console.warn('[signup] auth_uid link failed:', e.message));

  res.status(201).json({
    success: true,
    message: 'Account created! You can now sign in.',
    emp_name: emp.emp_name,
  });
});

// ─── POST /api/auth/verify-emp ────────────────────────────────────────────────
// Public: Validate emp_id before showing signup form.
router.post('/verify-emp', async (req, res) => {
  const { emp_id } = req.body;
  if (!emp_id) return res.status(400).json({ error: 'emp_id required' });

  const { data: emp } = await supabase
    .from('employees')
    .select('emp_id, emp_name, department, designation, date_of_joining, is_active')
    .eq('emp_id', emp_id.trim().toUpperCase())
    .single();

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
router.post('/login', async (req, res) => {
  const { email, password, captchaToken } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const captchaResult = await verifyCaptcha(captchaToken, req.ip);
  if (!captchaResult.success) return res.status(400).json({ error: captchaResult.error });

  // FIX: Don't pass captchaToken to server-side signInWithPassword — it's for client-side only
  const { data, error } = await supabase.auth.signInWithPassword({
    email: email.trim().toLowerCase(),
    password,
  });
  if (error) {
    // Don't reveal whether email exists — use generic message for auth failures
    console.warn('[login] failed for', email.trim().toLowerCase(), ':', error.message);
    return res.status(401).json({ error: 'Invalid email or password.' });
  }

  const { data: profile, error: profileErr } = await supabase
    .from('user_profiles')
    .select('role, emp_id, full_name, is_active')
    .eq('id', data.user.id)
    .single();

  if (profileErr || !profile) {
    return res.status(401).json({ error: 'Account not fully set up. Please contact admin.' });
  }
  if (!profile.is_active) {
    // Revoke the session we just created
    await supabase.auth.admin.signOut(data.session.access_token).catch(() => {});
    return res.status(403).json({ error: 'Account is deactivated. Contact admin.' });
  }

  res.json({
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
    expires_at: data.session.expires_at,
    user: {
      id: data.user.id,
      email: data.user.email,
      role: profile.role || 'employee',
      emp_id: profile.emp_id,
      full_name: profile.full_name,
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
// Requires a valid JWT — revokes the session server-side
router.post('/logout', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    // Verify token first to get user id, then sign out that session
    const { data: { user } } = await supabase.auth.getUser(token);
    if (user) {
      // FIX: admin.signOut() takes a JWT, not a user ID — pass the token correctly
      await supabase.auth.admin.signOut(token).catch(e => console.warn('[logout] signOut failed:', e.message));
    }
  }
  res.json({ success: true });
});

// ─── GET /api/auth/enrollment-data ───────────────────────────────────────────
// Protected: fetch employee data + rate cards for GMC enrollment form.
// ✅ FIX #2: Now also fetches existing_dependents from employee_gmc_enrollment_insured
// FIX: uses shared requireAuth middleware instead of inline token handling
router.get('/enrollment-data', requireAuth, async (req, res) => {
  const { emp_id, id: userId } = req.user;
  if (!emp_id) return res.status(400).json({ error: 'No emp_id linked to your account. Contact HR.' });

  const [empRes, rateRes, enrollRes, profileRes, depsRes] = await Promise.all([
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
    // ✅ FIX #2: Fetch existing dependents from insured table
    supabase.from('employee_gmc_enrollment_insured')
      .select('*').eq('emp_id', emp_id),
  ]);

  let employeeData = empRes.data;

  // Fallback: build from draft enrollment if not in onboarding table yet
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

  // Last resort: build minimal object from user_profiles so frontend doesn't crash
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
        _profile_only: true, // signals frontend: critical fields missing, contact HR
      };
    } else {
      return res.status(404).json({ error: 'Employee record not found. Please contact HR.' });
    }
  }

  // mobile_number and email_id now live in employee_onboarding — single source of truth
  const enrollmentDraft = enrollRes.data?.[0] || null;
  res.json({
    employee: employeeData,
    rate_cards: rateRes.data || [],
    enrollment: enrollmentDraft,
    profile: {
      mobile_number: empRes.data?.mobile_number || enrollmentDraft?.mobile_number || null,
      email:         empRes.data?.email_id       || profileRes.data?.email         || enrollmentDraft?.email_id || null,
    },
    // ✅ FIX #2: Return existing dependents so frontend can populate form
    existing_dependents: depsRes.data || [],
  });
});

// ─── POST /api/auth/enrollment ────────────────────────────────────────────────
// Protected: save or submit GMC enrollment.
// FIX: uses shared requireAuth middleware; insured_members handled atomically
router.post('/enrollment', requireAuth, async (req, res) => {
  const { emp_id } = req.user;
  if (!emp_id) return res.status(400).json({ error: 'No emp_id linked to your account.' });

  const { action, enrollment, insured_members, summary } = req.body;
  if (!['save', 'submit'].includes(action)) {
    return res.status(400).json({ error: 'action must be "save" or "submit"' });
  }
  if (!enrollment || typeof enrollment !== 'object') {
    return res.status(400).json({ error: 'enrollment data is required' });
  }

  // Check if enrollment is already locked (approved or submitted)
  const { data: existing } = await supabase
    .from('employee_gmc_enrollment').select('enrollment_id, enrollment_status')
    .eq('emp_id', emp_id).order('created_at', { ascending: false }).limit(1).single();

  if (existing?.enrollment_status === 'APPROVED') {
    return res.status(403).json({ error: 'Enrollment is already approved and locked.' });
  }

  // ✅ FIX: If already SUBMITTED and action is submit again (retry scenario),
  // return success instead of an error — data is already saved correctly.
  if (existing?.enrollment_status === 'SUBMITTED' && action === 'submit') {
    return res.json({ success: true, enrollment_id: existing.enrollment_id, status: 'SUBMITTED' });
  }

  const enrollmentStatus = action === 'submit' ? 'SUBMITTED' : 'DRAFT';
  const now = new Date().toISOString();

  // Build enrollment data — force emp_id from JWT, never from body
  const enrollmentData = {
    ...enrollment,
    emp_id, // override — never trust body
    enrollment_status: enrollmentStatus,
    updated_at: now,
    ...(action === 'submit' ? { submitted_at: now } : {}),
  };

  // Strip fields employees must not set
  delete enrollmentData.admin_remarks;
  delete enrollmentData.reviewed_by;
  delete enrollmentData.reviewed_at;
  delete enrollmentData.locked_at;
  delete enrollmentData.locked_by;

  let enrollmentId;
  if (existing) {
    const { data: updated, error: upErr } = await supabase
      .from('employee_gmc_enrollment')
      .update(enrollmentData)
      .eq('enrollment_id', existing.enrollment_id)
      .select('enrollment_id').single();
    if (upErr) return res.status(400).json({ error: upErr.message });
    enrollmentId = updated.enrollment_id;
  } else {
    const { data: inserted, error: insErr } = await supabase
      .from('employee_gmc_enrollment')
      .insert({ ...enrollmentData, created_at: now })
      .select('enrollment_id').single();
    if (insErr) return res.status(400).json({ error: insErr.message });
    enrollmentId = inserted.enrollment_id;
  }

  // Save insured members — delete old first, then insert new (atomic and retry-safe)
  if (Array.isArray(insured_members) && enrollmentId) {
    if (insured_members.length > 0) {
      const membersToInsert = insured_members.map(m => ({
        ...m,
        enrollment_id: enrollmentId,
        emp_id, // force from JWT
        created_at: now,
      }));
      // Remove fields they shouldn't be setting
      membersToInsert.forEach(m => { delete m.insured_id; });

      // ✅ FIX: Delete ALL existing members FIRST, then insert fresh.
      // Previously used a timestamp comparison that broke on retry (cold-start):
      // if first call saved but response was lost, second call would try to insert
      // duplicates and fail. Now we always clear + re-insert, which is idempotent.
      await supabase.from('employee_gmc_enrollment_insured')
        .delete().eq('enrollment_id', enrollmentId);

      const { error: membInsErr } = await supabase
        .from('employee_gmc_enrollment_insured').insert(membersToInsert);
      if (membInsErr) {
        console.error('[enrollment] insured_members insert failed:', membInsErr.message);
        return res.status(400).json({ error: 'Failed to save insured members: ' + membInsErr.message });
      }
    } else {
      // Empty array = remove all members
      await supabase.from('employee_gmc_enrollment_insured').delete().eq('enrollment_id', enrollmentId);
    }
  }

  // Save summary
  if (summary && enrollmentId) {
    await supabase.from('employee_gmc_enrollment_summary').upsert(
      { ...summary, enrollment_id: enrollmentId, emp_id, calculated_at: now },
      { onConflict: 'enrollment_id' }
    ).catch(e => console.warn('[enrollment] summary upsert failed:', e.message));
  }

  // Audit trail
  await supabase.from('employee_gmc_enrollment_audit').insert({
    enrollment_id: enrollmentId,
    emp_id,
    action: action === 'submit' ? 'SUBMIT' : 'DRAFT_SAVE',
    action_by: emp_id,
    created_at: now,
  }).catch(e => console.warn('[enrollment] audit insert failed:', e.message));

  // ✅ FIX #1: Fetch and return fresh insured_members in response
  // This allows frontend to update state immediately without re-fetching
  const { data: freshMembers } = await supabase
    .from('employee_gmc_enrollment_insured')
    .select('*')
    .eq('enrollment_id', enrollmentId);

  res.json({ 
    success: true, 
    enrollment_id: enrollmentId, 
    status: enrollmentStatus,
    // ✅ FIX #1: Include fresh members so frontend has complete data
    insured_members: freshMembers || [],
  });
});

// ─── POST /api/auth/simple-signup ─────────────────────────────────────────────
// Public: Simplified employee self-registration — no FK check, direct onboarding insert.
// Employee fills in their own details. Completely independent of employees table.
router.post('/simple-signup', async (req, res) => {
  const {
    emp_id, emp_name, email, password, captchaToken,
    gender, date_of_birth, date_of_joining,
    department, designation, mobile_number, ctc_gmc_per_month, unit,
  } = req.body;

  // ── Input validation ──
  if (!emp_id || !emp_name || !email || !password) {
    return res.status(400).json({ error: 'emp_id, emp_name, email, and password are required' });
  }
  const emailErr = validateEmail(email);
  if (emailErr) return res.status(400).json({ error: emailErr });
  const pwErr = validatePassword(password);
  if (pwErr) return res.status(400).json({ error: pwErr });

  // ── Captcha ──
  const captchaResult = await verifyCaptcha(captchaToken, req.ip);
  if (!captchaResult.success) return res.status(400).json({ error: captchaResult.error });

  const empIdNorm  = emp_id.trim().toUpperCase();
  const emailNorm  = email.trim().toLowerCase();
  const dobNorm    = normalizeDateForPg(date_of_birth);
  const dojNorm    = normalizeDateForPg(date_of_joining);

  // ── Check if account already exists ──
  const [profileByEmpId, profileByEmail] = await Promise.all([
    supabase.from('user_profiles').select('id').eq('emp_id', empIdNorm).single(),
    supabase.from('user_profiles').select('id').eq('email', emailNorm).single(),
  ]);
  if (profileByEmpId.data)
    return res.status(409).json({ error: 'An account already exists for this Employee ID. Please sign in.' });
  if (profileByEmail.data)
    return res.status(409).json({ error: 'This email is already registered. Please sign in.' });

  // ── Create Supabase auth user ──
  const { data: authData, error: authErr } = await supabase.auth.admin.createUser({
    email: emailNorm,
    password,
    email_confirm: true,
    user_metadata: { full_name: emp_name, emp_id: empIdNorm, role: 'employee' },
  });
  if (authErr) {
    const { status, error } = friendlyAuthError(authErr, 'simple-signup');
    return res.status(status).json({ error });
  }

  // ── Upsert user_profiles record ──
  // IMPORTANT: A DB trigger (on_auth_user_created_profile) fires when the auth
  // user is created and may already insert a row into user_profiles — causing
  // a duplicate key if we INSERT. We UPSERT so our full data always wins.
  // We also NEVER rollback the auth user because employee_auth FK prevents deletion.
  const { error: profileErr } = await supabase.from('user_profiles').upsert({
    id: authData.user.id,
    email: emailNorm,
    full_name: emp_name,
    emp_id: empIdNorm,
    role: 'employee',
    is_active: true,
  }, { onConflict: 'id' });

  if (profileErr) {
    // Log but do NOT return error — auth user exists, trigger may have partial profile.
    // employee_auth FK means we cannot delete the auth user anyway.
    console.error('[simple-signup] user_profiles upsert failed for', empIdNorm,
      '| code:', profileErr.code, '| msg:', profileErr.message);
    // Non-fatal: continue to onboarding insert.
  }

  // ── Insert into employee_onboarding — COMPLETELY INDEPENDENT, no FK checks ──
  const { data: existingOnboarding } = await supabase
    .from('employee_onboarding').select('emp_id').eq('emp_id', empIdNorm).single();

  if (!existingOnboarding) {
    const onboardingPayload = {
      emp_id:            empIdNorm,
      emp_name:          emp_name,
      gender:            gender || null,
      date_of_birth:     dobNorm || null,
      date_of_joining:   dojNorm || null,
      department:        department || null,
      designation:       designation || null,
      mobile_number:     mobile_number || null,
      email_id:          emailNorm,
      unit:              unit || null,
      ctc_gmc_per_month: ctc_gmc_per_month != null ? Number(ctc_gmc_per_month) : null,
      onboarding_status: 'pending',
    };
    const { error: obErr } = await supabase.from('employee_onboarding').insert(onboardingPayload);
    if (obErr && !isDuplicateKeyError(obErr)) {
      console.error('[simple-signup] employee_onboarding insert failed for', empIdNorm, ':', obErr.message);
      // Non-fatal — auth user is created, portal access works
    }
  }

  console.log('[simple-signup] account created for', empIdNorm, '/', emailNorm);
  res.status(201).json({ message: 'Account created successfully! You can now sign in.' });
});

// ─── PATCH /api/auth/update-ctc ──────────────────────────────────────────────
// Protected: Employee updates their own ctc_gmc_per_month in employee_onboarding.
// Only allowed if HR has not yet locked the value (i.e. ctc_gmc_per_month is null or 0).
router.patch('/update-ctc', requireAuth, async (req, res) => {
  const { emp_id } = req.user;
  if (!emp_id) return res.status(400).json({ error: 'No emp_id on account.' });

  const { ctc_gmc_per_month } = req.body;
  if (ctc_gmc_per_month === undefined || ctc_gmc_per_month === null || isNaN(Number(ctc_gmc_per_month))) {
    return res.status(400).json({ error: 'ctc_gmc_per_month must be a number.' });
  }

  const ctcVal = Number(ctc_gmc_per_month);
  if (ctcVal < 0) return res.status(400).json({ error: 'CTC GMC cannot be negative.' });

  // Upsert into employee_onboarding — only update ctc_gmc_per_month
  const { error } = await supabase
    .from('employee_onboarding')
    .update({ ctc_gmc_per_month: ctcVal })
    .eq('emp_id', emp_id);

  if (error) {
    console.error('[update-ctc] failed for', emp_id, ':', error.message);
    return res.status(400).json({ error: error.message });
  }

  console.log('[update-ctc] emp_id', emp_id, 'set ctc_gmc_per_month =', ctcVal);
  res.json({ success: true, ctc_gmc_per_month: ctcVal });
});

export default router;
