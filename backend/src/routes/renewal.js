// ═══════════════════════════════════════════════════════════════════════════════
// GMC Renewal 2026-27 routes (COMPLETELY FIXED v2)
// Mounted at /api/renewal
// ✅ FIXES: quote returns members[], eligibility returns calc{}, SI from insurance_dependents
// ═══════════════════════════════════════════════════════════════════════════════
import { Router } from 'express';
import { supabase } from '../index.js';

const router = Router();

const RENEWAL_POLICY_YEAR    = '2026-27';
const POLICY_START_DATE      = '2026-08-01';
const POLICY_END_DATE        = '2027-07-31';
const EMI_MONTHS             = 6;

const SUM_INSURED_LADDER = [200000, 300000, 400000, 500000, 600000, 700000, 1000000];
const EDITABLE_DEP_FIELDS = new Set(['dependent_name', 'date_of_birth', 'gender']);
const DELETE_REASONS = new Set(['EXPIRED', 'NOT_CONTINUING']);

let enrollmentWindowCache = {
  window_open: false,
  window_title: 'GMC Renewal 2026-27',
  deadline_date: '2026-07-15',
  last_updated: null,
};

async function initializeEnrollmentWindow() {
  try {
    const { data, error } = await supabase
      .from('renewal_config_2026_27')
      .select('window_open, window_title, deadline_date, updated_at')
      .eq('id', 1).single();
    if (!error && data) {
      enrollmentWindowCache = {
        window_open: data.window_open === true,
        window_title: data.window_title || 'GMC Renewal 2026-27',
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
        .select('window_open, window_title, deadline_date, updated_at')
        .eq('id', 1).single();
      if (!error && data) {
        const oldStatus = enrollmentWindowCache.window_open;
        enrollmentWindowCache = {
          window_open: data.window_open === true,
          window_title: data.window_title || 'GMC Renewal 2026-27',
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

// ✅ Get 25-26 financial figures from vw_employee_net_balance_2025_26
async function get2526Figures(empIdParam) {
  const { data: bal } = await supabase
    .from('vw_employee_net_balance_2025_26')
    .select('total_ctc_gmc, opening_balance_24_25, total_premium, salary_gmc_deducted, net_balance')
    .eq('emp_id', empIdParam).single();
  return {
    ctc_gmc_25_26:           Number(bal?.total_ctc_gmc || 0),
    opening_balance_25_26:   Number(bal?.opening_balance_24_25 || 0),
    salary_deductions_25_26: Number(bal?.salary_gmc_deducted || 0),
    premium_25_26:           Number(bal?.total_premium || 0),
    closing_balance_25_26:   Number(bal?.net_balance || 0),
  };
}

// ✅ Get previous SI from insurance_dependents (25-26 FINAL); fallback to enrollment
async function getPreviousSumInsured(empIdParam) {
  const { data: insDeps } = await supabase
    .from('insurance_dependents')
    .select('sum_insured').eq('emp_id', empIdParam);
  if (insDeps && insDeps.length > 0) {
    const maxSI = Math.max(...insDeps.map(d => Number(d.sum_insured || 0)));
    if (maxSI > 0) return maxSI;
  }
  const { data: enrolls } = await supabase
    .from('employee_gmc_enrollment')
    .select('selected_sum_insured, submitted_at')
    .eq('emp_id', empIdParam)
    .in('enrollment_status', ['APPROVED', 'SUBMITTED'])
    .order('submitted_at', { ascending: false, nullsFirst: false }).limit(1);
  if (enrolls?.[0]?.selected_sum_insured) return Number(enrolls[0].selected_sum_insured);
  return 300000;
}

// ─── GET /api/renewal/eligibility ─────────────────────────────────────────────
router.get('/eligibility', async (req, res) => {
  const { emp_id, role } = req.user;
  const empIdParam = (req.query.emp_id || emp_id || '').toString().toUpperCase();
  if (!empIdParam) return res.status(400).json({ error: 'emp_id required' });
  if (!requireOwnEmpOrAdmin(req, empIdParam)) return res.status(403).json({ error: 'Access denied' });

  const { data: emp, error: empErr } = await supabase
    .from('employees')
    .select('emp_id, emp_name, designation, unit, department, date_of_birth, email_id, mobile_number, gmc_inclusion_date, ctc_gmc_per_month, is_active')
    .eq('emp_id', empIdParam).single();
  if (empErr || !emp) return res.status(404).json({ error: 'Employee not found' });

  const eligible = emp.is_active !== false && !!emp.gmc_inclusion_date;
  const currentSumInsured = await getPreviousSumInsured(empIdParam);
  const calc = await get2526Figures(empIdParam);

  const { data: renewalEnroll } = await supabase
    .from('renewal_enrollment_2026_27')
    .select('enrollment_id, enrollment_status, submitted_at')
    .eq('emp_id', empIdParam).eq('policy_year', RENEWAL_POLICY_YEAR)
    .order('submitted_at', { ascending: false, nullsFirst: false }).limit(1);

  if (role === 'employee' && req.user.emp_id === empIdParam) {
    const m = await supabase.from('renewal_monitor_2026_27')
      .select('visited_renewal_page_at, page_visit_count').eq('emp_id', empIdParam).single();
    await bumpMonitor(empIdParam, {
      visited_renewal_page_at: m.data?.visited_renewal_page_at || new Date().toISOString(),
      page_visit_count: (m.data?.page_visit_count || 0) + 1,
      email_id: emp.email_id, full_name: emp.emp_name,
    });
  }

  const availableSumInsured = SUM_INSURED_LADDER.filter(s => s >= currentSumInsured);

  res.json({
    eligible,
    reason: !eligible
      ? (!emp.is_active ? 'INACTIVE' : !emp.gmc_inclusion_date ? 'NO_GMC_INCLUSION_DATE' : 'UNKNOWN') : null,
    window: getEnrollmentWindow(),
    employee: emp,
    calc,
    current_sum_insured: currentSumInsured,
    available_sum_insured: availableSumInsured,
    existing_renewal: renewalEnroll?.[0] || null,
    validation_errors: [
      ...(!emp.mobile_number ? [{ field: 'mobile_number', message: 'Mobile number missing' }] : []),
      ...(!emp.email_id ? [{ field: 'email_id', message: 'Email missing' }] : []),
    ],
    policy_start_date: POLICY_START_DATE,
  });
});

// ─── GET /api/renewal/dependents/:empId ───────────────────────────────────────
router.get('/dependents/:empId', async (req, res) => {
  const empIdParam = req.params.empId.toUpperCase();
  if (!requireOwnEmpOrAdmin(req, empIdParam)) return res.status(403).json({ error: 'Access denied' });
  const { data, error } = await supabase
    .from('renewal_dependents_2026_27').select('*').eq('emp_id', empIdParam).order('id');
  if (error) return res.status(400).json({ error: error.message });
  res.json({ data: data || [] });
});

// ─── PATCH /api/renewal/dependents/:id ────────────────────────────────────────
router.patch('/dependents/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
  const { data: row, error: fetchErr } = await supabase
    .from('renewal_dependents_2026_27').select('*').eq('id', id).single();
  if (fetchErr || !row) return res.status(404).json({ error: 'Dependent not found' });
  if (!requireOwnEmpOrAdmin(req, row.emp_id)) return res.status(403).json({ error: 'Access denied' });
  if (row.is_locked) return res.status(409).json({ error: 'This row is locked (renewal submitted). Contact HR.' });
  if (!isWindowOpen() && req.user.role === 'employee')
    return res.status(409).json({ error: 'Renewal window is closed.' });
  const body = req.body || {};
  const updates = {};
  for (const k of Object.keys(body)) {
    if (EDITABLE_DEP_FIELDS.has(k)) updates[k] = body[k] === '' ? null : body[k];
  }
  if (Object.keys(updates).length === 0)
    return res.status(400).json({ error: 'No editable fields provided.' });
  updates.edited = true;
  updates.updated_at = new Date().toISOString();
  const { error: updErr } = await supabase
    .from('renewal_dependents_2026_27').update(updates).eq('id', id);
  if (updErr) return res.status(400).json({ error: updErr.message });
  res.json({ success: true });
});

// ─── POST /api/renewal/dependents/:id/delete ──────────────────────────────────
router.post('/dependents/:id/delete', async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
  const { reason } = req.body || {};
  if (!DELETE_REASONS.has(reason))
    return res.status(400).json({ error: `Reason must be one of: ${[...DELETE_REASONS].join(', ')}` });
  const { data: row, error: fetchErr } = await supabase
    .from('renewal_dependents_2026_27').select('*').eq('id', id).single();
  if (fetchErr || !row) return res.status(404).json({ error: 'Dependent not found' });
  if (!requireOwnEmpOrAdmin(req, row.emp_id)) return res.status(403).json({ error: 'Access denied' });
  if (row.is_locked) return res.status(409).json({ error: 'This row is locked. Contact HR.' });
  if (!isWindowOpen() && req.user.role === 'employee')
    return res.status(409).json({ error: 'Renewal window is closed.' });
  const { error: updErr } = await supabase
    .from('renewal_dependents_2026_27')
    .update({ action: 'DELETE', delete_reason: reason, edited: true, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (updErr) return res.status(400).json({ error: updErr.message });
  res.json({ success: true });
});

// ─── POST /api/renewal/dependents/:id/restore ──────────────────────────────────
router.post('/dependents/:id/restore', async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
  const { data: row, error: fetchErr } = await supabase
    .from('renewal_dependents_2026_27').select('*').eq('id', id).single();
  if (fetchErr || !row) return res.status(404).json({ error: 'Dependent not found' });
  if (!requireOwnEmpOrAdmin(req, row.emp_id)) return res.status(403).json({ error: 'Access denied' });
  if (row.is_locked) return res.status(409).json({ error: 'This row is locked. Contact HR.' });
  if (!isWindowOpen() && req.user.role === 'employee')
    return res.status(409).json({ error: 'Renewal window is closed.' });
  const { error: updErr } = await supabase
    .from('renewal_dependents_2026_27')
    .update({ action: 'KEEP', delete_reason: null, edited: true, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (updErr) return res.status(400).json({ error: updErr.message });
  res.json({ success: true });
});

// ─── POST /api/renewal/quote ──────────────────────────────────────────────────
// ✅ FIX: Returns members[] + ALL financial fields the frontend expects
router.post('/quote', async (req, res) => {
  const { emp_id: bodyEmp, sum_insured } = req.body || {};
  const empIdParam = (bodyEmp || req.user.emp_id || '').toString().toUpperCase();
  const sumInsured = Number(sum_insured);

  if (!empIdParam) return res.status(400).json({ error: 'emp_id required' });
  if (!requireOwnEmpOrAdmin(req, empIdParam)) return res.status(403).json({ error: 'Access denied' });
  if (!SUM_INSURED_LADDER.includes(sumInsured))
    return res.status(400).json({ error: 'Invalid Sum Insured' });

  const { data: rates } = await supabase
    .from('gmc_premium_rates_26_27').select('*').eq('sum_insured', sumInsured);
  if (!rates || rates.length === 0)
    return res.status(400).json({ error: 'Premium rates not configured for this Sum Insured.' });

  const { data: emp } = await supabase.from('employees')
    .select('emp_name, date_of_birth, gender').eq('emp_id', empIdParam).single();
  if (!emp) return res.status(404).json({ error: 'Employee not found' });

  const { data: keepDeps } = await supabase
    .from('renewal_dependents_2026_27').select('*').eq('emp_id', empIdParam).eq('action', 'KEEP');

  const findRate = (age) => {
    const r = rates.find(x => age >= x.age_min && age <= x.age_max);
    return r ? Number(r.annual_premium) : 0;
  };

  // ✅ members[] — Self FIRST
  const selfAge = ageOnPolicyStart(emp.date_of_birth);
  const members = [{
    member_name: emp.emp_name, relation: 'Self',
    age_at_policy_start: selfAge, annual_premium: findRate(selfAge),
  }];
  for (const d of (keepDeps || [])) {
    const a = ageOnPolicyStart(d.date_of_birth);
    members.push({
      member_name: d.dependent_name, relation: d.relation,
      age_at_policy_start: a, annual_premium: findRate(a),
    });
  }
  const totalPremium = members.reduce((s, m) => s + m.annual_premium, 0);

  const fig = await get2526Figures(empIdParam);
  const ctc = fig.ctc_gmc_25_26;
  const closing = fig.closing_balance_25_26;
  const net = closing + ctc - totalPremium;
  const refund_sep_26 = Math.max(0, Math.min(closing, net));
  const refund_sep_27 = Math.max(0, net - refund_sep_26);
  const salary_deduction = Math.max(0, -net);

  res.json({
    sum_insured: sumInsured,
    members,
    total_premium_26_27: totalPremium,
    ctc_gmc_26_27: ctc,
    closing_balance_25_26: closing,
    refund_sep_2026: refund_sep_26,
    refund_sep_2027_estimate: refund_sep_27,
    salary_deduction_26_27: salary_deduction,
    emi_per_month_6mo: Math.round((salary_deduction / EMI_MONTHS) * 100) / 100,
  });
});

// ─── POST /api/renewal/submit ─────────────────────────────────────────────────
router.post('/submit', async (req, res) => {
  const { emp_id: bodyEmp, sum_insured } = req.body || {};
  const empIdParam = (bodyEmp || req.user.emp_id || '').toString().toUpperCase();
  const sumInsured = Number(sum_insured);

  if (!empIdParam) return res.status(400).json({ error: 'emp_id required' });
  if (!requireOwnEmpOrAdmin(req, empIdParam)) return res.status(403).json({ error: 'Access denied' });
  if (!SUM_INSURED_LADDER.includes(sumInsured))
    return res.status(400).json({ error: 'Invalid Sum Insured' });
  if (!isWindowOpen() && req.user.role === 'employee')
    return res.status(409).json({ error: 'Renewal window is closed.' });

  const { data: existing } = await supabase
    .from('renewal_enrollment_2026_27').select('enrollment_id, enrollment_status')
    .eq('emp_id', empIdParam).eq('policy_year', RENEWAL_POLICY_YEAR)
    .in('enrollment_status', ['SUBMITTED','APPROVED']).limit(1);
  if (existing && existing.length > 0)
    return res.status(409).json({ error: 'Renewal already submitted.' });

  const { data: emp } = await supabase.from('employees')
    .select('emp_id, emp_name, date_of_birth, gender, email_id, mobile_number, designation, unit, department, gmc_inclusion_date')
    .eq('emp_id', empIdParam).single();
  if (!emp) return res.status(404).json({ error: 'Employee not found' });

  const { data: keepDeps } = await supabase
    .from('renewal_dependents_2026_27').select('*').eq('emp_id', empIdParam).eq('action', 'KEEP');
  const { data: rates } = await supabase
    .from('gmc_premium_rates_26_27').select('*').eq('sum_insured', sumInsured);
  if (!rates || rates.length === 0)
    return res.status(400).json({ error: 'Premium rates not configured.' });

  const findRate = (age) => {
    const r = rates.find(x => age >= x.age_min && age <= x.age_max);
    return r ? Number(r.annual_premium) : 0;
  };

  const selfAge = ageOnPolicyStart(emp.date_of_birth);
  const insuredRows = [{
    emp_id: empIdParam, relationship: 'Self', insured_name: emp.emp_name,
    gender: emp.gender, date_of_birth: emp.date_of_birth, age_as_on_doj: selfAge,
    sum_insured: sumInsured, annual_premium: findRate(selfAge), coverage_days: 365,
    prorated_premium: findRate(selfAge),
  }];
  for (const d of (keepDeps || [])) {
    const a = ageOnPolicyStart(d.date_of_birth);
    const p = findRate(a);
    insuredRows.push({
      emp_id: empIdParam, relationship: d.relation, insured_name: d.dependent_name,
      gender: d.gender, date_of_birth: d.date_of_birth, age_as_on_doj: a,
      sum_insured: sumInsured, annual_premium: p, coverage_days: 365, prorated_premium: p,
    });
  }
  const totalPremium = insuredRows.reduce((s, r) => s + r.annual_premium, 0);

  const nowIso = new Date().toISOString();
  const enrollPayload = {
    emp_id: empIdParam, emp_name: emp.emp_name, department: emp.department,
    designation: emp.designation, date_of_joining: emp.gmc_inclusion_date,
    email_id: emp.email_id, mobile_number: emp.mobile_number,
    selected_sum_insured: sumInsured,
    enrollment_status: 'SUBMITTED', submitted_at: nowIso,
    terms_accepted: true, final_declaration_accepted: true,
    policy_year: RENEWAL_POLICY_YEAR, updated_at: nowIso,
  };

  const { data: enrollIns, error: enrollErr } = await supabase
    .from('renewal_enrollment_2026_27').insert(enrollPayload).select('enrollment_id').single();
  if (enrollErr) return res.status(400).json({ error: 'Submit failed: ' + enrollErr.message });

  const enrollment_id = enrollIns.enrollment_id;
  const insertRows = insuredRows.map(r => ({ ...r, enrollment_id }));
  const { error: insErr } = await supabase.from('renewal_enrollment_insured_2026_27').insert(insertRows);
  if (insErr) {
    await supabase.from('renewal_enrollment_2026_27').delete().eq('enrollment_id', enrollment_id);
    return res.status(500).json({ error: 'Failed to save insured members: ' + insErr.message });
  }

  const fig = await get2526Figures(empIdParam);
  const ctc = fig.ctc_gmc_25_26;
  const closing = fig.closing_balance_25_26;
  const net = closing + ctc - totalPremium;
  const refund_sep_26 = Math.max(0, Math.min(closing, net));
  const refund_sep_27 = Math.max(0, net - refund_sep_26);
  const salary_deduction = Math.max(0, -net);

  try {
    await supabase.from('renewal_enrollment_summary_2026_27').upsert({
      enrollment_id, emp_id: empIdParam,
      total_insurer_premium: totalPremium,
      total_ctc_gmc_available: ctc,
      closing_balance_25_26: closing,
      ctc_gmc_26_27_projected: ctc,
      salary_deduction,
      gmc_refund_sep_2026: refund_sep_26,
      gmc_refund_sep_2027_est: refund_sep_27,
      emi_per_month_6mo: Math.round((salary_deduction / EMI_MONTHS) * 100) / 100,
      calculated_at: nowIso, updated_at: nowIso,
    }, { onConflict: 'enrollment_id' });
  } catch (e) {
    console.warn('[renewal] Summary insert failed:', e.message);
  }

  try {
    await supabase.from('renewal_dependents_2026_27')
      .update({ is_locked: true, enrollment_id, updated_at: nowIso })
      .eq('emp_id', empIdParam);
  } catch (e) {
    console.warn('[renewal] lock dependents failed:', e.message);
  }

  await bumpMonitor(empIdParam, { submitted_at: nowIso, enrollment_id });

  res.json({
    success: true, enrollment_id,
    total_premium_26_27: totalPremium,
    ctc_gmc_26_27: ctc,
    closing_balance_25_26: closing,
    refund_sep_2026: refund_sep_26,
    refund_sep_2027_estimate: refund_sep_27,
    salary_deduction_26_27: salary_deduction,
    emi_per_month_6mo: Math.round((salary_deduction / EMI_MONTHS) * 100) / 100,
  });
});

// ─── ADMIN: GET /api/renewal/admin/progress ───────────────────────────────────
router.get('/admin/progress', async (req, res) => {
  if (!['admin','hr'].includes(req.user.role))
    return res.status(403).json({ error: 'Admin/HR only' });
  const { data, error } = await supabase
    .from('vw_renewal_progress').select('*').order('emp_id');
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
