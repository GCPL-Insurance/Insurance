import express from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { supabase } from '../index.js';

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET;
const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET_KEY;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function generateAccessToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '15m' });
}

function generateRefreshToken(payload) {
  return jwt.sign(payload, JWT_REFRESH_SECRET, { expiresIn: '7d' });
}

function verifyAccessToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

function verifyRefreshToken(token) {
  return jwt.verify(token, JWT_REFRESH_SECRET);
}

async function verifyCaptcha(token) {
  if (!token) return false;
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret: TURNSTILE_SECRET, response: token }),
    });
    const data = await res.json();
    return data.success === true;
  } catch {
    return false;
  }
}

function authMiddleware(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });
  try {
    const decoded = verifyAccessToken(token);
    req.user = decoded;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// ─── POST /api/onboarding/verify-emp ─────────────────────────────────────────

router.post('/verify-emp', async (req, res) => {
  try {
    const { emp_id } = req.body;
    if (!emp_id) return res.status(400).json({ error: 'Employee ID required' });

    const empIdUpper = emp_id.trim().toUpperCase();

    // Check employee_onboarding first
    const { data: onboardingData } = await supabase
      .from('employee_onboarding')
      .select('emp_id, emp_name, gender, date_of_birth, date_of_joining, department, designation, ctc_gmc_per_month, onboarding_status, unit')
      .eq('emp_id', empIdUpper)
      .single();

    if (onboardingData) {
      const { data: profileData } = await supabase
        .from('user_profiles')
        .select('emp_id, role')
        .eq('emp_id', empIdUpper)
        .single();

      return res.json({
        found: true,
        source: 'onboarding',
        already_registered: !!profileData,
        ...onboardingData,
      });
    }

    // Fall back to employees table
    const { data: employeeData } = await supabase
      .from('employees')
      .select('emp_id, emp_name, gender, date_of_birth, date_of_joining, department, designation, ctc_gmc_per_month, unit')
      .eq('emp_id', empIdUpper)
      .single();

    if (employeeData) {
      const { data: profileData } = await supabase
        .from('user_profiles')
        .select('emp_id, role')
        .eq('emp_id', empIdUpper)
        .single();

      return res.json({
        found: true,
        source: 'employees',
        already_registered: !!profileData,
        ...employeeData,
      });
    }

    return res.json({ found: false });
  } catch (err) {
    console.error('verify-emp error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── POST /api/onboarding/signup ──────────────────────────────────────────────

router.post('/signup', async (req, res) => {
  try {
    const {
      emp_id, emp_name, email, password,
      gender, date_of_birth, date_of_joining,
      department, designation, unit, captcha_token,
    } = req.body;

    const captchaOk = await verifyCaptcha(captcha_token);
    if (!captchaOk) return res.status(400).json({ error: 'Captcha verification failed' });

    if (!emp_id || !emp_name || !email || !password)
      return res.status(400).json({ error: 'Missing required fields' });

    if (!unit)
      return res.status(400).json({ error: 'Unit is required' });

    if (password.length < 8 || !/[a-zA-Z]/.test(password) || !/[0-9]/.test(password))
      return res.status(400).json({ error: 'Password must be at least 8 characters with letters and numbers' });

    const empIdUpper = emp_id.trim().toUpperCase();

    const { data: existingProfile } = await supabase
      .from('user_profiles')
      .select('emp_id')
      .eq('emp_id', empIdUpper)
      .single();

    if (existingProfile)
      return res.status(400).json({ error: 'Employee ID already registered. Please sign in.' });

    const { data: existingEmail } = await supabase
      .from('user_profiles')
      .select('emp_id')
      .eq('email', email.toLowerCase())
      .single();

    if (existingEmail)
      return res.status(400).json({ error: 'Email already registered.' });

    const password_hash = await bcrypt.hash(password, 12);

    const { error: onboardingError } = await supabase
      .from('employee_onboarding')
      .upsert({
        emp_id: empIdUpper,
        emp_name: emp_name.trim(),
        gender: gender || null,
        date_of_birth: date_of_birth || null,
        date_of_joining: date_of_joining || null,
        department: department || null,
        designation: designation || null,
        unit: unit || null,
        onboarding_status: 'pending',
      }, { onConflict: 'emp_id' });

    if (onboardingError) {
      console.error('Onboarding upsert error:', onboardingError);
      return res.status(500).json({ error: 'Failed to create onboarding record' });
    }

    const { error: profileError } = await supabase
      .from('user_profiles')
      .insert({
        emp_id: empIdUpper,
        emp_name: emp_name.trim(),
        email: email.toLowerCase(),
        password_hash,
        role: 'onboarding',
      });

    if (profileError) {
      console.error('Profile insert error:', profileError);
      return res.status(500).json({ error: 'Failed to create user account' });
    }

    res.json({ success: true, message: 'Account created successfully. Please sign in.' });
  } catch (err) {
    console.error('signup error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── POST /api/onboarding/login ───────────────────────────────────────────────

router.post('/login', async (req, res) => {
  try {
    const { emp_id, password, captcha_token } = req.body;

    const captchaOk = await verifyCaptcha(captcha_token);
    if (!captchaOk) return res.status(400).json({ error: 'Captcha verification failed' });

    if (!emp_id || !password)
      return res.status(400).json({ error: 'Employee ID and password required' });

    const empIdUpper = emp_id.trim().toUpperCase();

    const { data: profile, error: profileError } = await supabase
      .from('user_profiles')
      .select('emp_id, emp_name, email, password_hash, role')
      .eq('emp_id', empIdUpper)
      .single();

    if (profileError || !profile)
      return res.status(401).json({ error: 'Invalid credentials' });

    if (profile.role === 'admin' || profile.role === 'hr')
      return res.status(403).json({ error: 'Please use the main portal to sign in.' });

    if (profile.role !== 'onboarding' && profile.role !== 'employee')
      return res.status(403).json({ error: 'Access denied for this portal.' });

    const passwordMatch = await bcrypt.compare(password, profile.password_hash);
    if (!passwordMatch)
      return res.status(401).json({ error: 'Invalid credentials' });

    const tokenPayload = {
      emp_id: profile.emp_id,
      emp_name: profile.emp_name,
      email: profile.email,
      role: profile.role,
    };

    const accessToken = generateAccessToken(tokenPayload);
    const refreshToken = generateRefreshToken(tokenPayload);

    await supabase
      .from('refresh_tokens')
      .insert({ emp_id: profile.emp_id, token: refreshToken, created_at: new Date().toISOString() });

    res.json({ access_token: accessToken, refresh_token: refreshToken, user: tokenPayload });
  } catch (err) {
    console.error('login error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── POST /api/onboarding/refresh ────────────────────────────────────────────

router.post('/refresh', async (req, res) => {
  try {
    const { refresh_token } = req.body;
    if (!refresh_token) return res.status(401).json({ error: 'No refresh token' });

    let decoded;
    try {
      decoded = verifyRefreshToken(refresh_token);
    } catch {
      return res.status(401).json({ error: 'Invalid or expired refresh token' });
    }

    const { data: tokenRecord } = await supabase
      .from('refresh_tokens')
      .select('emp_id')
      .eq('token', refresh_token)
      .single();

    if (!tokenRecord)
      return res.status(401).json({ error: 'Refresh token not found' });

    const { data: profile } = await supabase
      .from('user_profiles')
      .select('emp_id, emp_name, email, role')
      .eq('emp_id', decoded.emp_id)
      .single();

    if (!profile) return res.status(401).json({ error: 'User not found' });

    const tokenPayload = {
      emp_id: profile.emp_id,
      emp_name: profile.emp_name,
      email: profile.email,
      role: profile.role,
    };

    const newAccessToken = generateAccessToken(tokenPayload);
    const newRefreshToken = generateRefreshToken(tokenPayload);

    await supabase.from('refresh_tokens').delete().eq('token', refresh_token);
    await supabase.from('refresh_tokens').insert({
      emp_id: profile.emp_id,
      token: newRefreshToken,
      created_at: new Date().toISOString(),
    });

    res.json({ access_token: newAccessToken, refresh_token: newRefreshToken });
  } catch (err) {
    console.error('refresh error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── GET /api/onboarding/me ───────────────────────────────────────────────────

router.get('/me', authMiddleware, async (req, res) => {
  try {
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('emp_id, emp_name, email, role')
      .eq('emp_id', req.user.emp_id)
      .single();

    if (!profile) return res.status(404).json({ error: 'User not found' });
    res.json({ user: profile });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── POST /api/onboarding/logout ─────────────────────────────────────────────

router.post('/logout', authMiddleware, async (req, res) => {
  try {
    const { refresh_token } = req.body;
    if (refresh_token) {
      await supabase.from('refresh_tokens').delete().eq('token', refresh_token);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── GET /api/onboarding/enrollment-data ─────────────────────────────────────

router.get('/enrollment-data', authMiddleware, async (req, res) => {
  try {
    const emp_id = req.user.emp_id;

    const { data: onboardingData } = await supabase
      .from('employee_onboarding')
      .select('*')
      .eq('emp_id', emp_id)
      .single();

    if (onboardingData) {
      const { data: enrollmentData } = await supabase
        .from('employee_gmc_enrollment')
        .select('*')
        .eq('emp_id', emp_id)
        .single();

      return res.json({ employee: onboardingData, enrollment: enrollmentData || null, profile: null });
    }

    const { data: employeeData } = await supabase
      .from('employees')
      .select('emp_id, emp_name, gender, date_of_birth, date_of_joining, department, designation, ctc_gmc_per_month, unit')
      .eq('emp_id', emp_id)
      .single();

    if (!employeeData)
      return res.status(404).json({ error: 'Employee data not found' });

    const { data: enrollmentData } = await supabase
      .from('employee_gmc_enrollment')
      .select('*')
      .eq('emp_id', emp_id)
      .single();

    return res.json({ employee: employeeData, enrollment: enrollmentData || null, profile: null });
  } catch (err) {
    console.error('enrollment-data error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── POST /api/onboarding/enrollment ─────────────────────────────────────────

router.post('/enrollment', authMiddleware, async (req, res) => {
  try {
    const emp_id = req.user.emp_id;
    const { enrollment_data, submit } = req.body;

    if (!enrollment_data)
      return res.status(400).json({ error: 'Enrollment data required' });

    const { data: existing } = await supabase
      .from('employee_gmc_enrollment')
      .select('enrollment_id, enrollment_status')
      .eq('emp_id', emp_id)
      .single();

    if (existing && existing.enrollment_status === 'SUBMITTED')
      return res.status(400).json({ error: 'Enrollment already submitted and cannot be modified.' });

    const enrollmentStatus = submit ? 'SUBMITTED' : 'DRAFT';

    const enrollmentRecord = {
      emp_id,
      ...enrollment_data,
      enrollment_status: enrollmentStatus,
      updated_at: new Date().toISOString(),
    };

    if (!existing) enrollmentRecord.created_at = new Date().toISOString();

    const { data: upserted, error: upsertError } = await supabase
      .from('employee_gmc_enrollment')
      .upsert(enrollmentRecord, { onConflict: 'emp_id' })
      .select('enrollment_id')
      .single();

    if (upsertError) {
      console.error('Enrollment upsert error:', upsertError);
      return res.status(500).json({ error: 'Failed to save enrollment' });
    }

    // ── Insert into employee_gmc_enrollment_insured ───────────────────────────
    const enrollment_id = upserted?.enrollment_id || existing?.enrollment_id;
    if (enrollment_id) {
      let empData = null;
      const { data: oe } = await supabase
        .from('employee_onboarding')
        .select('emp_name, date_of_birth, gender, date_of_joining')
        .eq('emp_id', emp_id).single();
      if (oe) { empData = oe; } else {
        const { data: ee } = await supabase
          .from('employees')
          .select('emp_name, date_of_birth, gender, date_of_joining')
          .eq('emp_id', emp_id).single();
        empData = ee;
      }

      if (empData) {
        const POLICY_END = new Date('2026-07-31');
        const doj = empData.date_of_joining;
        const sumInsured = Number(enrollment_data.sum_insured || 300000);

        const ageAsOf = (dobStr, refStr) => {
          if (!dobStr || !refStr) return 0;
          const dob = new Date(dobStr), ref = new Date(refStr);
          let age = ref.getFullYear() - dob.getFullYear();
          const m = ref.getMonth() - dob.getMonth();
          if (m < 0 || (m === 0 && ref.getDate() < dob.getDate())) age--;
          return Math.max(0, age);
        };

        const days = Math.max(1, Math.floor((POLICY_END - new Date(doj || Date.now())) / 86400000) + 1);

        const annualPremium = (rel, age) => {
          const mult = sumInsured / 300000;
          const base = rel === 'Self' ? 2500 : rel === 'Spouse' ? 2200 : rel === 'Child' ? 1200 : 2800;
          return Math.round((base + (age > 45 ? (age - 45) * 60 : 0)) * mult);
        };

        let dependents = [];
        try { dependents = enrollment_data.dependents ? JSON.parse(enrollment_data.dependents) : []; } catch { dependents = []; }

        const rows = [];

        // Self (mandatory)
        const selfAge = ageAsOf(empData.date_of_birth, doj);
        const selfPrem = annualPremium('Self', selfAge);
        rows.push({
          enrollment_id, emp_id, relationship: 'Self',
          insured_name: empData.emp_name, gender: empData.gender,
          date_of_birth: empData.date_of_birth, age_as_on_doj: selfAge,
          sum_insured: sumInsured, annual_premium: selfPrem, coverage_days: days,
          prorated_premium: Math.round((selfPrem / 365) * days * 100) / 100,
        });

        // Dependents
        for (const dep of dependents) {
          if (!dep.relationship || !dep.name || !dep.dob || !dep.gender) continue;
          const depAge = ageAsOf(dep.dob, doj);
          const depPrem = annualPremium(dep.relationship, depAge);
          rows.push({
            enrollment_id, emp_id, relationship: dep.relationship,
            insured_name: dep.name, gender: dep.gender,
            date_of_birth: dep.dob, age_as_on_doj: depAge,
            sum_insured: sumInsured, annual_premium: depPrem, coverage_days: days,
            prorated_premium: Math.round((depPrem / 365) * days * 100) / 100,
          });
        }

        await supabase.from('employee_gmc_enrollment_insured').delete().eq('enrollment_id', enrollment_id);
        const { error: insuredErr } = await supabase.from('employee_gmc_enrollment_insured').insert(rows);
        if (insuredErr) {
          console.error('Insured insert error:', insuredErr);
          if (submit) return res.status(500).json({ error: 'Failed to save insured members.' });
        }
      }
    }

    if (submit) {
      await supabase
        .from('employee_onboarding')
        .update({ onboarding_status: 'enrollment_submitted' })
        .eq('emp_id', emp_id);
    }

    res.json({
      success: true,
      message: submit ? 'Enrollment submitted successfully!' : 'Draft saved.',
      status: enrollmentStatus,
    });
  } catch (err) {
    console.error('enrollment save error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;