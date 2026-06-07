// ═══════════════════════════════════════════════════════════════════════════════
// GMC RENEWAL 2026-27 — PRODUCTION-GRADE ROUTES (FINAL)
// Mounted at /api/renewal
// Insurance Period: 24-JUL-2026 to 23-JUL-2027
// =============================================================================

import { Router } from 'express';
import { supabase } from '../index.js';

const router = Router();

const RENEWAL_POLICY_YEAR     = '2026-27';
const POLICY_START_DATE       = '2026-07-24';
const POLICY_END_DATE         = '2027-07-23';
const CUTOFF_AGE_DATE         = '2001-07-24';  // Children age 25 on policy start
const EMI_MONTHS              = 6;
const NEW_SPOUSE_DAYS_LIMIT   = 30;
const NEWBORN_DAYS_LIMIT      = 30;
const MIN_SPOUSE_AGE          = 18;

const SUM_INSURED_LADDER = [200000, 300000, 400000, 500000, 600000, 700000, 1000000];
const EDITABLE_DEP_FIELDS = new Set(['insured_name', 'date_of_birth', 'gender']);
const DELETE_REASONS = new Set(['EXPIRED', 'NOT_CONTINUING', 'TYPO']);

let enrollmentWindowCache = {
  window_open: false,
  window_title: 'GMC Renewal 2026-27',
  policy_start_date: POLICY_START_DATE,
  policy_end_date: POLICY_END_DATE,
  deadline_date: '2026-07-15',
  last_updated: null,
};

// ─────────────────────────────────────────────────────────────────────────────
// INITIALIZATION & POLLING
// ─────────────────────────────────────────────────────────────────────────────

async function initializeEnrollmentWindow() {
  try {
    const { data, error } = await supabase
      .from('renewal_config_2026_27')
      .select('window_open, window_title, deadline_date, policy_start_date, policy_end_date, updated_at')
      .eq('id', 1).single();
    if (!error && data) {
      enrollmentWindowCache = {
        window_open: data.window_open === true,
        window_title: data.window_title || 'GMC Renewal 2026-27',
        policy_start_date: data.policy_start_date || POLICY_START_DATE,
        policy_end_date: data.policy_end_date || POLICY_END_DATE,
        deadline_date: data.deadline_date || '2026-07-15',
        last_updated: data.updated_at || new Date().toISOString(),
      };
      console.log('[renewal] Window initialized:', enrollmentWindowCache.window_open);
    }
  } catch (e) {
    console.warn('[renewal] Failed to initialize window:', e.message);
  }
}

async function startEnrollmentWindowPolling() {
  setInterval(async () => {
    try {
      const { data, error } = await supabase
        .from('renewal_config_2026_27')
        .select('window_open, window_title, deadline_date, policy_start_date, policy_end_date, updated_at')
        .eq('id', 1).single();
      if (!error && data) {
        const oldStatus = enrollmentWindowCache.window_open;
        enrollmentWindowCache = {
          window_open: data.window_open === true,
          window_title: data.window_title || 'GMC Renewal 2026-27',
          policy_start_date: data.policy_start_date || POLICY_START_DATE,
          policy_end_date: data.policy_end_date || POLICY_END_DATE,
          deadline_date: data.deadline_date || '2026-07-15',
          last_updated: data.updated_at || new Date().toISOString(),
        };
        if (oldStatus !== enrollmentWindowCache.window_open)
          console.log('[renewal] Window status changed to:', enrollmentWindowCache.window_open);
      }
    } catch (e) {
      console.warn('[renewal] Polling failed:', e.message);
    }
  }, 30000);
}

function isWindowOpen() { return enrollmentWindowCache.window_open === true; }

function getEnrollmentWindow() {
  return {
    open_at: enrollmentWindowCache.last_updated || new Date().toISOString(),
    close_at: enrollmentWindowCache.deadline_date,
    policy_start_date: enrollmentWindowCache.policy_start_date,
    policy_end_date: enrollmentWindowCache.policy_end_date,
    is_open: enrollmentWindowCache.window_open === true,
  };
}

function requireOwnEmpOrAdmin(req, empIdParam) {
  const { role, emp_id } = req.user;
  if (role === 'admin' || role === 'hr') return true;
  return role === 'employee' && emp_id === empIdParam;
}

async function bumpMonitor(emp_id, fields) {
  if (!emp_id) return;
  try {
    await supabase.from('renewal_monitor_2026_27')
      .upsert({ emp_id, ...fields, updated_at: new Date().toISOString() }, { onConflict: 'emp_id' });
  } catch (e) {
    console.warn('[renewal monitor bump failed]', e.message);
  }
}

function ageOnPolicyStart(dob) {
  if (!dob) return 0;
  const start = new Date(POLICY_START_DATE);
  const d = new Date(dob);
  let age = start.getFullYear() - d.getFullYear();
  const m = start.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && start.getDate() < d.getDate())) age--;
  return Math.max(0, age);
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/renewal/eligibility
// ─────────────────────────────────────────────────────────────────────────────
router.get('/eligibility', async (req, res) => {
  const { emp_id, role } = req.user;
  const empIdParam = (req.query.emp_id || emp_id || '').toString().toUpperCase();
  if (!empIdParam) return res.status(400).json({ error: 'emp_id required' });
  if (!requireOwnEmpOrAdmin(req, empIdParam)) return res.status(403).json({ error: 'Access denied' });

  // Get employee record
  const { data: emp, error: empErr } = await supabase
    .from('employees')
    .select('emp_id, emp_name, designation, unit, department, date_of_birth, email_id, mobile_number, gmc_inclusion_date, ctc_gmc_per_month, is_active')
    .eq('emp_id', empIdParam).single();
  if (empErr || !emp) return res.status(404).json({ error: 'Employee not found' });

  // ELIGIBILITY: Must be active AND have gmc_inclusion_date
  const eligible = emp.is_active !== false && !!emp.gmc_inclusion_date;

  // Determine if EXISTING (has renewal_insured_25_26_data) or NEW JOINEE
  const { data: existingMembers } = await supabase
    .from('renewal_insured_25_26_data')
    .select('id', { count: 'exact' })
    .eq('emp_id', empIdParam)
    .eq('status', 'A');
  const isExistingEmployee = existingMembers && existingMembers.length > 0;

  // Get previous sum insured from sum_insured_25_26
  const { data: siData } = await supabase
    .from('sum_insured_25_26')
    .select('sum_insured')
    .eq('emp_id', empIdParam)
    .single();
  const previousSumInsured = siData?.sum_insured || 300000;

  // Get 25-26 financial figures
  const { data: bal } = await supabase
    .from('vw_employee_net_balance_2025_26')
    .select('total_ctc_gmc, opening_balance_24_25, total_premium, salary_gmc_deducted, net_balance')
    .eq('emp_id', empIdParam).single();

  const calc = {
    ctc_gmc_25_26: Number(bal?.total_ctc_gmc || 0),
    opening_balance_25_26: Number(bal?.opening_balance_24_25 || 0),
    salary_deductions_25_26: Number(bal?.salary_gmc_deducted || 0),
    premium_25_26: Number(bal?.total_premium || 0),
    closing_balance_25_26: Number(bal?.net_balance || 0),
  };

  // Check existing renewal
  const { data: renewalEnroll } = await supabase
    .from('renewal_enrollment_2026_27')
    .select('enrollment_id, enrollment_status, submitted_at')
    .eq('emp_id', empIdParam)
    .eq('policy_year', RENEWAL_POLICY_YEAR)
    .order('submitted_at', { ascending: false, nullsFirst: false })
    .limit(1);

  // Bump monitor for employees
  if (role === 'employee' && req.user.emp_id === empIdParam) {
    const m = await supabase.from('renewal_monitor_2026_27')
      .select('visited_renewal_page_at, page_visit_count').eq('emp_id', empIdParam).single();
    await bumpMonitor(empIdParam, {
      visited_renewal_page_at: m.data?.visited_renewal_page_at || new Date().toISOString(),
      page_visit_count: (m.data?.page_visit_count || 0) + 1,
      email_id: emp.email_id,
      full_name: emp.emp_name,
    });
  }

  const availableSumInsured = SUM_INSURED_LADDER.filter(s => s >= previousSumInsured);

  res.json({
    eligible,
    is_existing_employee: isExistingEmployee,
    reason: !eligible
      ? (!emp.is_active ? 'INACTIVE' : !emp.gmc_inclusion_date ? 'NO_GMC_INCLUSION_DATE' : 'UNKNOWN') : null,
    window: getEnrollmentWindow(),
    employee: emp,
    calc,
    previous_sum_insured: previousSumInsured,
    available_sum_insured: availableSumInsured,
    existing_renewal: renewalEnroll?.[0] || null,
    validation_errors: [
      ...(!emp.mobile_number ? [{ field: 'mobile_number', message: 'Mobile number missing' }] : []),
      ...(!emp.email_id ? [{ field: 'email_id', message: 'Email missing' }] : []),
    ],
    policy_start_date: POLICY_START_DATE,
    policy_end_date: POLICY_END_DATE,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/renewal/members/:empId
// ─────────────────────────────────────────────────────────────────────────────
router.get('/members/:empId', async (req, res) => {
  const { empId } = req.params;
  const empIdParam = (empId || '').toString().toUpperCase();
  if (!empIdParam) return res.status(400).json({ error: 'emp_id required' });
  if (!requireOwnEmpOrAdmin(req, empIdParam)) return res.status(403).json({ error: 'Access denied' });

  const { data: members, error } = await supabase
    .from('renewal_members_2026_27')
    .select('*')
    .eq('emp_id', empIdParam)
    .order('relationship', { ascending: true });

  if (error) return res.status(400).json({ error: error.message });
  res.json({ members: members || [] });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/renewal/members/:empId
// Add or update a member
// ─────────────────────────────────────────────────────────────────────────────
router.post('/members/:empId', async (req, res) => {
  const { empId } = req.params;
  const empIdParam = (empId || '').toString().toUpperCase();
  const { id, insured_name, relationship, gender, date_of_birth, action, delete_reason, delete_remarks, marriage_date, addition_type } = req.body;

  if (!empIdParam) return res.status(400).json({ error: 'emp_id required' });
  if (!requireOwnEmpOrAdmin(req, empIdParam)) return res.status(403).json({ error: 'Access denied' });

  // VALIDATION: Cannot delete Self
  if (relationship === 'Self' && action === 'DELETE') {
    return res.status(400).json({ error: 'Cannot delete Self member' });
  }

  // VALIDATION: Spouse must be >= 18 years old
  if (relationship === 'Spouse' && date_of_birth) {
    const age = ageOnPolicyStart(date_of_birth);
    if (age < MIN_SPOUSE_AGE) {
      return res.status(400).json({ error: `Spouse must be at least ${MIN_SPOUSE_AGE} years old` });
    }
  }

  // VALIDATION: Children age validation
  if (relationship === 'Child' || relationship === 'Son' || relationship === 'Daughter') {
    if (new Date(date_of_birth) <= new Date(CUTOFF_AGE_DATE)) {
      return res.status(400).json({
        error: 'Child has completed 25 years of age on 24-JUL-2026 and is no longer eligible for coverage',
      });
    }
  }

  // VALIDATION: New spouse - check 30 days from marriage
  if (addition_type === 'NEW_SPOUSE' && marriage_date) {
    const now = new Date();
    const marriage = new Date(marriage_date);
    const daysDiff = Math.floor((now - marriage) / (1000 * 60 * 60 * 24));
    if (daysDiff > NEW_SPOUSE_DAYS_LIMIT) {
      return res.status(400).json({
        error: `Spouse can be added only within 30 days of marriage date. ${daysDiff} days have passed.`,
      });
    }
  }

  // VALIDATION: Newborn - check 30 days from birth
  if (addition_type === 'NEWBORN') {
    const now = new Date();
    const dob = new Date(date_of_birth);
    const daysDiff = Math.floor((now - dob) / (1000 * 60 * 60 * 24));
    if (daysDiff > NEWBORN_DAYS_LIMIT) {
      return res.status(400).json({
        error: `Newborn can be added only within 30 days of birth. ${daysDiff} days have passed.`,
      });
    }
  }

  const nowIso = new Date().toISOString();
  const payload = {
    emp_id: empIdParam,
    insured_name,
    relationship,
    gender,
    date_of_birth,
    action,
    delete_reason: action === 'DELETE' ? delete_reason : null,
    delete_remarks: action === 'DELETE' ? delete_remarks : null,
    marriage_date: relationship === 'Spouse' ? marriage_date : null,
    addition_type,
    addition_date: addition_type ? nowIso : null,
    edited: id ? true : false,
    updated_at: nowIso,
  };

  try {
    if (id) {
      // UPDATE existing
      const { error } = await supabase
        .from('renewal_members_2026_27')
        .update(payload)
        .eq('id', id)
        .eq('emp_id', empIdParam);
      if (error) return res.status(400).json({ error: error.message });
      res.json({ success: true, message: 'Member updated' });
    } else {
      // INSERT new
      const { data, error } = await supabase
        .from('renewal_members_2026_27')
        .insert(payload)
        .select('id')
        .single();
      if (error) return res.status(400).json({ error: error.message });
      res.json({ success: true, id: data.id, message: 'Member added' });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/renewal/members/:memberId
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/members/:memberId', async (req, res) => {
  const { memberId } = req.params;
  const { emp_id } = req.body;

  if (!requireOwnEmpOrAdmin(req, emp_id)) return res.status(403).json({ error: 'Access denied' });

  const { error } = await supabase
    .from('renewal_members_2026_27')
    .delete()
    .eq('id', memberId)
    .eq('emp_id', emp_id);

  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true, message: 'Member deleted' });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/renewal/quote/:empId
// Calculate premium quote (before submission)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/quote/:empId', async (req, res) => {
  const { empId } = req.params;
  const empIdParam = (empId || '').toString().toUpperCase();
  const sumInsured = Number(req.query.sum_insured);

  if (!empIdParam || !sumInsured) {
    return res.status(400).json({ error: 'emp_id and sum_insured required' });
  }
  if (!requireOwnEmpOrAdmin(req, empIdParam)) return res.status(403).json({ error: 'Access denied' });
  if (!SUM_INSURED_LADDER.includes(sumInsured)) {
    return res.status(400).json({ error: 'Invalid sum_insured' });
  }

  const { data: emp } = await supabase
    .from('employees')
    .select('emp_id, emp_name, date_of_birth, gender')
    .eq('emp_id', empIdParam).single();
  if (!emp) return res.status(404).json({ error: 'Employee not found' });

  const { data: members } = await supabase
    .from('renewal_members_2026_27')
    .select('*')
    .eq('emp_id', empIdParam)
    .eq('action', 'KEEP');

  const { data: rates } = await supabase
    .from('gmc_premium_rates_26_27')
    .select('*')
    .eq('sum_insured', sumInsured);

  if (!rates || rates.length === 0) {
    return res.status(400).json({ error: 'Premium rates not configured' });
  }

  const findRate = (age) => {
    const r = rates.find(x => age >= x.age_min && age <= x.age_max);
    return r ? Number(r.annual_premium) : 0;
  };

  // Calculate premium
  const selfAge = ageOnPolicyStart(emp.date_of_birth);
  const membersList = [{
    member_name: emp.emp_name,
    relationship: 'Self',
    age_at_policy_start: selfAge,
    annual_premium: findRate(selfAge),
  }];

  for (const m of (members || [])) {
    const age = ageOnPolicyStart(m.date_of_birth);
    membersList.push({
      member_name: m.insured_name,
      relationship: m.relationship,
      age_at_policy_start: age,
      annual_premium: findRate(age),
    });
  }

  const totalPremium = membersList.reduce((s, m) => s + m.annual_premium, 0);

  // Get 25-26 figures
  const { data: bal } = await supabase
    .from('vw_employee_net_balance_2025_26')
    .select('total_ctc_gmc, opening_balance_24_25, net_balance')
    .eq('emp_id', empIdParam).single();

  const ctc = Number(bal?.total_ctc_gmc || 0);
  const closing = Number(bal?.net_balance || 0);
  const net = closing + ctc - totalPremium;
  const refund_sep_26 = Math.max(0, Math.min(closing, net));
  const refund_sep_27 = Math.max(0, net - refund_sep_26);
  const salary_deduction = Math.max(0, -net);

  res.json({
    sum_insured: sumInsured,
    members: membersList,
    total_premium_26_27: totalPremium,
    ctc_gmc_26_27: ctc,
    closing_balance_25_26: closing,
    refund_sep_2026: refund_sep_26,
    refund_sep_2027_estimate: refund_sep_27,
    salary_deduction_26_27: salary_deduction,
    emi_per_month_6mo: salary_deduction > 0 ? Math.round((salary_deduction / EMI_MONTHS) * 100) / 100 : 0,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/renewal/submit
// Final submission
// ─────────────────────────────────────────────────────────────────────────────
router.post('/submit', async (req, res) => {
  const { emp_id: bodyEmp, sum_insured } = req.body || {};
  const empIdParam = (bodyEmp || req.user.emp_id || '').toString().toUpperCase();
  const sumInsured = Number(sum_insured);

  if (!empIdParam) return res.status(400).json({ error: 'emp_id required' });
  if (!requireOwnEmpOrAdmin(req, empIdParam)) return res.status(403).json({ error: 'Access denied' });
  if (!SUM_INSURED_LADDER.includes(sumInsured)) {
    return res.status(400).json({ error: 'Invalid Sum Insured' });
  }
  if (!isWindowOpen() && req.user.role === 'employee') {
    return res.status(409).json({ error: 'Renewal window is closed.' });
  }

  // CHECK: Sum insured not decreased
  const { data: siData } = await supabase
    .from('sum_insured_25_26')
    .select('sum_insured')
    .eq('emp_id', empIdParam)
    .single();
  const previousSI = siData?.sum_insured || 300000;
  if (sumInsured < previousSI) {
    return res.status(400).json({
      error: `Sum insured cannot be decreased from previous year (${previousSI}). Selected: ${sumInsured}`,
    });
  }

  // CHECK: Not already submitted
  const { data: existing } = await supabase
    .from('renewal_enrollment_2026_27')
    .select('enrollment_id, enrollment_status')
    .eq('emp_id', empIdParam)
    .eq('policy_year', RENEWAL_POLICY_YEAR)
    .in('enrollment_status', ['SUBMITTED', 'APPROVED'])
    .limit(1);
  if (existing && existing.length > 0) {
    return res.status(409).json({ error: 'Renewal already submitted.' });
  }

  const { data: emp } = await supabase
    .from('employees')
    .select('emp_id, emp_name, date_of_birth, gender, email_id, mobile_number, designation, unit, department, gmc_inclusion_date')
    .eq('emp_id', empIdParam).single();
  if (!emp) return res.status(404).json({ error: 'Employee not found' });

  const { data: keepMembers } = await supabase
    .from('renewal_members_2026_27')
    .select('*')
    .eq('emp_id', empIdParam)
    .eq('action', 'KEEP');

  const { data: rates } = await supabase
    .from('gmc_premium_rates_26_27')
    .select('*')
    .eq('sum_insured', sumInsured);
  if (!rates || rates.length === 0) {
    return res.status(400).json({ error: 'Premium rates not configured.' });
  }

  const findRate = (age) => {
    const r = rates.find(x => age >= x.age_min && age <= x.age_max);
    return r ? Number(r.annual_premium) : 0;
  };

  const selfAge = ageOnPolicyStart(emp.date_of_birth);
  const insuredRows = [{
    emp_id: empIdParam,
    relationship: 'Self',
    insured_name: emp.emp_name,
    gender: emp.gender,
    date_of_birth: emp.date_of_birth,
    age_as_on_policy_start: selfAge,
    sum_insured: sumInsured,
    annual_premium: findRate(selfAge),
    coverage_days: 365,
    prorated_premium: findRate(selfAge),
  }];

  for (const m of (keepMembers || [])) {
    const age = ageOnPolicyStart(m.date_of_birth);
    const premium = findRate(age);
    insuredRows.push({
      emp_id: empIdParam,
      relationship: m.relationship,
      insured_name: m.insured_name,
      gender: m.gender,
      date_of_birth: m.date_of_birth,
      age_as_on_policy_start: age,
      sum_insured: sumInsured,
      annual_premium: premium,
      coverage_days: 365,
      prorated_premium: premium,
    });
  }

  const totalPremium = insuredRows.reduce((s, r) => s + r.annual_premium, 0);

  const nowIso = new Date().toISOString();
  const enrollPayload = {
    emp_id: empIdParam,
    emp_name: emp.emp_name,
    department: emp.department,
    designation: emp.designation,
    date_of_joining: emp.gmc_inclusion_date,
    email_id: emp.email_id,
    mobile_number: emp.mobile_number,
    selected_sum_insured: sumInsured,
    enrollment_status: 'SUBMITTED',
    submitted_at: nowIso,
    locked_at: nowIso,
    terms_accepted: true,
    policy_year: RENEWAL_POLICY_YEAR,
    updated_at: nowIso,
  };

  const { data: enrollIns, error: enrollErr } = await supabase
    .from('renewal_enrollment_2026_27')
    .insert(enrollPayload)
    .select('enrollment_id')
    .single();
  if (enrollErr) return res.status(400).json({ error: 'Submit failed: ' + enrollErr.message });

  const enrollment_id = enrollIns.enrollment_id;
  const insertRows = insuredRows.map(r => ({ ...r, enrollment_id }));
  const { error: insErr } = await supabase
    .from('renewal_enrollment_insured_2026_27')
    .insert(insertRows);
  if (insErr) {
    await supabase.from('renewal_enrollment_2026_27').delete().eq('enrollment_id', enrollment_id);
    return res.status(500).json({ error: 'Failed to save insured members: ' + insErr.message });
  }

  // Lock members
  await supabase.from('renewal_members_2026_27')
    .update({ is_locked: true, enrollment_id, updated_at: nowIso })
    .eq('emp_id', empIdParam);

  // Get figures
  const { data: bal } = await supabase
    .from('vw_employee_net_balance_2025_26')
    .select('total_ctc_gmc, net_balance')
    .eq('emp_id', empIdParam).single();

  const ctc = Number(bal?.total_ctc_gmc || 0);
  const closing = Number(bal?.net_balance || 0);
  const net = closing + ctc - totalPremium;
  const refund_sep_26 = Math.max(0, Math.min(closing, net));
  const refund_sep_27 = Math.max(0, net - refund_sep_26);
  const salary_deduction = Math.max(0, -net);

  // Create summary
  try {
    await supabase.from('renewal_enrollment_summary_2026_27').upsert({
      enrollment_id,
      emp_id: empIdParam,
      total_insurer_premium: totalPremium,
      total_ctc_gmc_available: ctc,
      closing_balance_25_26: closing,
      ctc_gmc_26_27_projected: ctc,
      salary_deduction,
      gmc_refund_sep_2026: refund_sep_26,
      gmc_refund_sep_2027_est: refund_sep_27,
      emi_per_month_6mo: salary_deduction > 0 ? Math.round((salary_deduction / EMI_MONTHS) * 100) / 100 : 0,
      calculated_at: nowIso,
      updated_at: nowIso,
    }, { onConflict: 'enrollment_id' });
  } catch (e) {
    console.warn('[renewal] Summary insert failed:', e.message);
  }

  // Bump monitor
  await bumpMonitor(empIdParam, { submitted_at: nowIso, enrollment_id });

  res.json({
    success: true,
    enrollment_id,
    total_premium_26_27: totalPremium,
    ctc_gmc_26_27: ctc,
    closing_balance_25_26: closing,
    refund_sep_2026: refund_sep_26,
    refund_sep_2027_estimate: refund_sep_27,
    salary_deduction_26_27: salary_deduction,
    emi_per_month_6mo: salary_deduction > 0 ? Math.round((salary_deduction / EMI_MONTHS) * 100) / 100 : 0,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN: GET /api/renewal/admin/progress
// ─────────────────────────────────────────────────────────────────────────────
router.get('/admin/progress', async (req, res) => {
  if (!['admin', 'hr'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Admin/HR only' });
  }
  const { data, error } = await supabase
    .from('vw_renewal_progress')
    .select('*')
    .order('emp_id');
  if (error) return res.status(400).json({ error: error.message });

  const totals = {
    total_eligible: data.length,
    submitted: data.filter(r => r.stage === 'SUBMITTED').length,
    visited_not_submitted: data.filter(r => r.stage === 'VISITED_NOT_SUBMITTED').length,
    logged_in_not_visited: data.filter(r => r.stage === 'LOGGED_IN_NOT_VISITED').length,
    never_logged_in: data.filter(r => r.stage === 'NEVER_LOGGED_IN').length,
  };
  totals.progress_percent = totals.total_eligible
    ? Math.round((totals.submitted / totals.total_eligible) * 100) : 0;

  res.json({ data, totals });
});

export default router;
export { initializeEnrollmentWindow, startEnrollmentWindowPolling };
