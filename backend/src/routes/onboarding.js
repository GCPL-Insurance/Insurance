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
// Priority: employees table (canonical) → employee_onboarding (fallback for new/onboarding employees)

router.post('/verify-emp', async (req, res) => {
  try {
    const { emp_id } = req.body;
    if (!emp_id) return res.status(400).json({ error: 'Employee ID required' });

    const empIdUpper = emp_id.trim().toUpperCase();

    // ── 1. Check employees table FIRST (canonical HR master) ─────────────────
    const { data: employeeData } = await supabase
      .from('employees')
      .select('emp_id, emp_name, gender, date_of_birth, date_of_joining, department, designation, ctc_gmc_per_month, unit, gmc_inclusion_date')
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

    // ── 2. Fall back to employee_onboarding (new / not-yet-in-HR-system employees) ──
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
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const { data: profile, error: profileErr } = await supabase
      .from('user_profiles')
      .select('emp_id, email, password_hash, role')
      .eq('email', email.toLowerCase())
      .single();

    if (profileErr || !profile) return res.status(401).json({ error: 'Invalid email or password' });

    const passwordMatch = await bcrypt.compare(password, profile.password_hash);
    if (!passwordMatch) return res.status(401).json({ error: 'Invalid email or password' });

    const { data: empMain } = await supabase
      .from('employees')
      .select('emp_id, emp_name, role, email_id')
      .eq('emp_id', profile.emp_id)
      .single();

    const emp_name = empMain?.emp_name || null;
    const role_final = empMain?.role || profile.role || 'employee';

    const accessToken = generateAccessToken({
      emp_id: profile.emp_id,
      email: profile.email,
      emp_name,
      role: role_final,
    });

    const refreshToken = generateRefreshToken({
      emp_id: profile.emp_id,
    });

    res.json({
      access_token: accessToken,
      refresh_token: refreshToken,
      user: { emp_id: profile.emp_id, email: profile.email, emp_name, role: role_final },
    });
  } catch (err) {
    console.error('login error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── POST /api/onboarding/refresh ─────────────────────────────────────────────

router.post('/refresh', async (req, res) => {
  try {
    const { refresh_token } = req.body;
    if (!refresh_token) return res.status(400).json({ error: 'Refresh token required' });

    const decoded = verifyRefreshToken(refresh_token);
    const { emp_id } = decoded;

    const { data: profile } = await supabase
      .from('user_profiles')
      .select('emp_id, email, role')
      .eq('emp_id', emp_id)
      .single();

    if (!profile) return res.status(401).json({ error: 'Token invalid' });

    const { data: empMain } = await supabase
      .from('employees')
      .select('emp_name, role')
      .eq('emp_id', emp_id)
      .single();

    const emp_name = empMain?.emp_name || null;
    const role_final = empMain?.role || profile.role || 'employee';

    const accessToken = generateAccessToken({
      emp_id: profile.emp_id,
      email: profile.email,
      emp_name,
      role: role_final,
    });

    const newRefreshToken = generateRefreshToken({ emp_id: profile.emp_id });

    res.json({
      access_token: accessToken,
      refresh_token: newRefreshToken,
      user: { emp_id: profile.emp_id, email: profile.email, emp_name, role: role_final },
    });
  } catch (err) {
    console.error('refresh error:', err);
    res.status(401).json({ error: 'Invalid refresh token' });
  }
});

// ─── GET /api/auth/enrollment-data ────────────────────────────────────────────

router.get('/enrollment-data', authMiddleware, async (req, res) => {
  try {
    const emp_id = req.user.emp_id;

    const [
      empMainRes,
      onboardingRes,
      enrollmentRes,
      depsRes,
      rateRes,
      ctcTotalRes,
    ] = await Promise.all([
        // 1. employees table (canonical HR master)
        supabase
          .from('employees')
          .select('emp_id, emp_name, gender, date_of_birth, date_of_joining, department, designation, ctc_gmc_per_month, unit, gmc_inclusion_date, gmc_effective_date')
          .eq('emp_id', emp_id)
          .single(),
        // 2. employee_onboarding (new employees / contact fields)
        supabase
          .from('employee_onboarding')
          .select('emp_name, date_of_birth, gender, date_of_joining, department, designation, ctc_gmc_per_month, unit, onboarding_status, mobile_number, email_id')
          .eq('emp_id', emp_id)
          .single(),
        // 3. existing enrollment draft (if any)
        supabase
          .from('employee_gmc_enrollment')
          .select('*')
          .eq('emp_id', emp_id)
          .eq('enrollment_status', 'DRAFT'),
        // 4. dependents from previous enrollment
        supabase
          .from('employee_gmc_enrollment_insured')
          .select('*')
          .eq('emp_id', emp_id),
        // 4. insurer rate cards for premium calculation
        supabase
          .from('gmc_rate_cards')
          .select('rate_card_id, rate_card_type, age_band_from, age_band_to, sum_insured, annual_premium')
          .eq('rate_card_type', 'INSURER')
          .order('sum_insured')
          .order('age_band_from'),
        // 5. pre-calculated CTC GMC total from view (employees-based, most accurate)
        supabase
          .from('vw_employee_ctc_gmc_total')
          .select('total_ctc_gmc')
          .eq('emp_id', emp_id)
          .single(),
        // 6. saved insured members from previous enrollment
        supabase
          .from('employee_gmc_enrollment_insured')
          .select('*')
          .eq('emp_id', emp_id),
      ]);

    const mainEmp   = empMainRes?.data;
    const onboarding = onboardingRes?.data;

    if (!mainEmp && !onboarding) {
      return res.status(404).json({ error: 'Employee data not found' });
    }

    const pick = (...vals) => vals.find(v => v !== null && v !== undefined) ?? null;

    const employeeData = {
      emp_id:             pick(mainEmp?.emp_id,             onboarding?.emp_id),
      emp_name:           pick(mainEmp?.emp_name,           onboarding?.emp_name),
      gender:             pick(mainEmp?.gender,             onboarding?.gender),
      date_of_birth:      pick(mainEmp?.date_of_birth,      onboarding?.date_of_birth),
      date_of_joining:    pick(mainEmp?.date_of_joining,    onboarding?.date_of_joining),
      department:         pick(mainEmp?.department,         onboarding?.department),
      designation:        pick(mainEmp?.designation,        onboarding?.designation),
      ctc_gmc_per_month:  pick(mainEmp?.ctc_gmc_per_month,  onboarding?.ctc_gmc_per_month),
      unit:               pick(mainEmp?.unit,               onboarding?.unit),
      gmc_inclusion_date: pick(mainEmp?.gmc_inclusion_date, onboarding?.gmc_inclusion_date),
      gmc_effective_date: mainEmp?.gmc_effective_date ?? null,
      mobile_number:      onboarding?.mobile_number ?? null,
      email_id:           onboarding?.email_id ?? null,
      onboarding_status:  onboarding?.onboarding_status ?? 'pending',
      _source:            mainEmp ? (onboarding ? 'merged' : 'employees_only') : 'onboarding_only',
    };

    const enrollmentDraft    = enrollmentRes?.data?.[0] || null;
    const existingDependents = depsRes?.data || [];

    return res.json({
      employee:   employeeData,
      enrollment: enrollmentDraft,
      rate_cards: rateRes?.data || [],
      profile: {
        mobile_number: onboarding?.mobile_number || enrollmentDraft?.mobile_number || null,
        email:         onboarding?.email_id      || enrollmentDraft?.email_id      || null,
      },
      existing_dependents: existingDependents,
      ctc_gmc_total_from_view: ctcTotalRes?.data?.total_ctc_gmc ?? null,
    });
  } catch (err) {
    console.error('enrollment-data error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── POST /api/onboarding/enrollment ───────────────────────────────────────────
// ✅ FIX: Syncs mobile_number and email_id to employees table on submit

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

    // ✅ FIX: Sync contact info to employees table (canonical source)
    if (submit) {
      try {
        const updatePayload = {};
        
        if (enrollment_data.mobile_number) {
          updatePayload.mobile_number = enrollment_data.mobile_number;
        }
        
        if (enrollment_data.email_id) {
          updatePayload.email_id = enrollment_data.email_id;
        }
        
        if (Object.keys(updatePayload).length > 0) {
          await supabase
            .from('employees')
            .update({
              ...updatePayload,
              updated_at: new Date().toISOString(),
            })
            .eq('emp_id', emp_id);
          console.log('[enrollment] Synced contact info for', emp_id);
        }
      } catch (e) {
        console.warn('[enrollment] Failed to sync to employees table:', e.message);
        // Non-blocking — enrollment was successful
      }
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
