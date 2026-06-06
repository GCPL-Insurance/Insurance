// ═══════════════════════════════════════════════════════════════════════════════
// GMC Renewal 2026-27 routes (FIXED)
// Mounted at /api/renewal
// ✅ FIX: Reads enrollment window status from database instead of hardcoded dates
// ✅ FIXED: Now queries window_start_date from database (was missing before!)
// ═══════════════════════════════════════════════════════════════════════════════
import { Router } from 'express';
import { supabase } from '../index.js';

const router = Router();

// ─── Constants ────────────────────────────────────────────────────────────────
const RENEWAL_POLICY_YEAR    = '2026-27';
const POLICY_START_DATE      = '2026-08-01';
const EMI_MONTHS             = 6;
const EMI_START_MONTH        = '2026-09';

const SUM_INSURED_LADDER = [200000, 300000, 400000, 500000, 600000, 700000, 1000000];
const EDITABLE_DEP_FIELDS = new Set(['dependent_name', 'date_of_birth', 'gender']);
const DELETE_REASONS = new Set(['EXPIRED', 'NOT_CONTINUING']);

// ✅ FIX: Cache enrollment window from database (ADDED window_start_date)
let enrollmentWindowCache = {
  window_open: false,
  window_title: 'GMC Renewal 2026-27',
  window_start_date: '2026-06-01',  // ✅ NEW: Store actual window start date
  deadline_date: '2026-07-15',
  last_updated: null,
};

// ✅ FIX: Initialize cache from database (ADDED window_start_date to query)
async function initializeEnrollmentWindow() {
  try {
    const { data, error } = await supabase
      .from('enrollment_windows')
      .select('window_open, window_title, window_start_date, deadline_date, updated_at')  // ✅ ADDED: window_start_date
      .eq('id', 1)
      .single();

    if (!error && data) {
      enrollmentWindowCache = {
        window_open: data.window_open === true,
        window_title: data.window_title || 'GMC Renewal 2026-27',
        window_start_date: data.window_start_date || '2026-06-01',  // ✅ NEW: Store from DB
        deadline_date: data.deadline_date || '2026-07-15',
        last_updated: data.updated_at || new Date().toISOString(),
      };
      console.log('[renewal] Window initialized from DB:', enrollmentWindowCache);
    }
  } catch (e) {
    console.warn('[renewal] Failed to initialize window:', e.message);
  }
}

// ✅ FIX: Refresh cache every 30 seconds (ADDED window_start_date to query)
async function startEnrollmentWindowPolling() {
  setInterval(async () => {
    try {
      const { data, error } = await supabase
        .from('enrollment_windows')
        .select('window_open, window_title, window_start_date, deadline_date, updated_at')  // ✅ ADDED: window_start_date
        .eq('id', 1)
        .single();

      if (!error && data) {
        const oldStatus = enrollmentWindowCache.window_open;
        enrollmentWindowCache = {
          window_open: data.window_open === true,
          window_title: data.window_title || 'GMC Renewal 2026-27',
          window_start_date: data.window_start_date || '2026-06-01',  // ✅ NEW: Store from DB
          deadline_date: data.deadline_date || '2026-07-15',
          last_updated: data.updated_at || new Date().toISOString(),
        };
        
        if (oldStatus !== enrollmentWindowCache.window_open) {
          console.log('[renewal] Window status changed to:', enrollmentWindowCache.window_open);
        }
      }
    } catch (e) {
      console.warn('[renewal] Polling failed:', e.message);
    }
  }, 30000);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function ageOnPolicyStart(dob) {
  if (!dob) return 0;
  const start = new Date(POLICY_START_DATE);
  const d = new Date(dob);
  let age = start.getFullYear() - d.getFullYear();
  const m = start.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && start.getDate() < d.getDate())) age--;
  return Math.max(0, age);
}

// ✅ FIX: Check database window status instead of hardcoded dates
function isWindowOpen() {
  return enrollmentWindowCache.window_open === true;
}

// ✅ FIX: Get window details (FIXED to use window_start_date instead of last_updated)
function getEnrollmentWindow() {
  return {
    open_at: enrollmentWindowCache.window_start_date,  // ✅ FIXED: Use window_start_date, not last_updated!
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
    const update = { ...fields, updated_at: new Date().toISOString() };
    await supabase.from('renewal_monitor_2026_27')
      .upsert({ emp_id, ...update }, { onConflict: 'emp_id' });
  } catch (e) {
    console.warn('[renewal monitor bump failed]', e.message);
  }
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
    .eq('emp_id', empIdParam)
    .single();

  if (empErr || !emp) return res.status(404).json({ error: 'Employee not found' });

  const eligible = emp.is_active !== false && !!emp.gmc_inclusion_date;

  // ✅ FIX: Fetch 25-26 figures from the correct view
  const { data: netBal } = await supabase
    .from('vw_employee_net_balance_2025_26')
    .select('total_ctc_gmc, opening_balance_24_25, salary_gmc_deducted, total_premium, net_balance')
    .eq('emp_id', empIdParam)
    .single();

  // Map view columns to the field names the frontend expects
  const calc = netBal ? {
    ctc_gmc_25_26:          Math.round(Number(netBal.total_ctc_gmc        || 0)),
    opening_balance_25_26:  Math.round(Number(netBal.opening_balance_24_25 || 0)),
    salary_deductions_25_26: Math.round(Number(netBal.salary_gmc_deducted  || 0)),
    premium_25_26:          Math.round(Number(netBal.total_premium         || 0)),
    closing_balance_25_26:  Math.round(Number(netBal.net_balance           || 0)),
  } : null;

  // ✅ FIX Bug 1: Fetch current sum insured STRICTLY from sum_insured_25_26 table.
  // Fallback to 300000 (standard) only if no record exists.
  const { data: siRow } = await supabase
    .from('sum_insured_25_26')
    .select('sum_insured')
    .eq('emp_id', empIdParam)
    .single();
  const currentSumInsured = siRow?.sum_insured ? Number(siRow.sum_insured) : 300000;

  const { data: renewalEnroll } = await supabase
    .from('employee_gmc_enrollment')
    .select('enrollment_id, enrollment_status, submitted_at')
    .eq('emp_id', empIdParam)
    .eq('policy_year', RENEWAL_POLICY_YEAR)
    .order('submitted_at', { ascending: false, nullsFirst: false })
    .limit(1);

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

  const availableSumInsured = SUM_INSURED_LADDER.filter(s => s >= currentSumInsured);

  res.json({
    eligible,
    reason: !eligible
      ? (!emp.is_active ? 'INACTIVE' : !emp.gmc_inclusion_date ? 'NO_GMC_INCLUSION_DATE' : 'UNKNOWN')
      : null,
    window: getEnrollmentWindow(),  // ✅ FIX: Use database value
    employee: emp,
    calc: calc || null,
    current_sum_insured: currentSumInsured,
    available_sum_insured: availableSumInsured,
    existing_renewal: renewalEnroll?.[0] || null,
    policy_start_date: POLICY_START_DATE,
  });
});

// ─── GET /api/renewal/dependents/:empId ───────────────────────────────────────
router.get('/dependents/:empId', async (req, res) => {
  const empIdParam = req.params.empId.toUpperCase();
  if (!requireOwnEmpOrAdmin(req, empIdParam)) return res.status(403).json({ error: 'Access denied' });

  const { data, error } = await supabase
    .from('renewal_dependents_2026_27')
    .select('*')
    .eq('emp_id', empIdParam)
    .order('id');

  if (error) return res.status(400).json({ error: error.message });
  res.json({ dependents: data || [] });
});

// ─── POST /api/renewal/dependents/:empId/add ──────────────────────────────────
router.post('/dependents/:empId/add', async (req, res) => {
  const empIdParam = req.params.empId.toUpperCase();
  if (!requireOwnEmpOrAdmin(req, empIdParam)) return res.status(403).json({ error: 'Access denied' });

  const { dependent_name, relation, gender, date_of_birth } = req.body || {};
  if (!dependent_name || !relation || !date_of_birth)
    return res.status(400).json({ error: 'dependent_name, relation, date_of_birth required' });

  const { data, error } = await supabase
    .from('renewal_dependents_2026_27')
    .insert({
      emp_id: empIdParam, dependent_name, relation, gender, date_of_birth,
      action: 'KEEP', created_at: new Date().toISOString(),
    })
    .select('*')
    .single();

  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// ─── POST /api/renewal/dependents/:empId/:depId/action ──────────────────────
router.post('/dependents/:empId/:depId/action', async (req, res) => {
  const empIdParam = req.params.empId.toUpperCase();
  const depId = req.params.depId;
  if (!requireOwnEmpOrAdmin(req, empIdParam)) return res.status(403).json({ error: 'Access denied' });

  const { action } = req.body || {};
  if (!DELETE_REASONS.has(action) && action !== 'KEEP')
    return res.status(400).json({ error: 'action must be KEEP, EXPIRED, or NOT_CONTINUING' });

  const { error } = await supabase
    .from('renewal_dependents_2026_27')
    .update({ action, updated_at: new Date().toISOString() })
    .eq('id', depId)
    .eq('emp_id', empIdParam);

  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true });
});

// ─── POST /api/renewal/submit ──────────────────────────────────────────────────
router.post('/submit', async (req, res) => {
  if (!isWindowOpen())
    return res.status(403).json({ error: 'Enrollment window is closed.' });

  const { emp_id } = req.user;
  const { sumInsured } = req.body || {};
  const empIdParam = (req.body?.emp_id || emp_id || '').toString().toUpperCase();

  if (!empIdParam) return res.status(400).json({ error: 'emp_id required' });
  if (!requireOwnEmpOrAdmin(req, empIdParam)) return res.status(403).json({ error: 'Access denied' });
  if (!sumInsured) return res.status(400).json({ error: 'sumInsured required' });

  const si = Number(sumInsured);
  if (!SUM_INSURED_LADDER.includes(si))
    return res.status(400).json({ error: 'Invalid sum insured value' });

  const { data: latestEnrolls } = await supabase
    .from('employee_gmc_enrollment')
    .select('selected_sum_insured')
    .eq('emp_id', empIdParam)
    .in('enrollment_status', ['APPROVED','SUBMITTED'])
    .order('submitted_at', { ascending: false, nullsFirst: false }).limit(1);
  const currentSI = Number(latestEnrolls?.[0]?.selected_sum_insured || 300000);
  if (si < currentSI)
    return res.status(400).json({ error: `Sum Insured cannot be reduced.` });

  const { data: existing } = await supabase
    .from('employee_gmc_enrollment').select('enrollment_id, enrollment_status')
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
    .from('gmc_premium_rates_26_27').select('*').eq('sum_insured', si);
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
    sum_insured: si, annual_premium: findRate(selfAge), coverage_days: 365,
    prorated_premium: findRate(selfAge),
  }];
  for (const d of (keepDeps || [])) {
    const a = ageOnPolicyStart(d.date_of_birth);
    const p = findRate(a);
    insuredRows.push({
      emp_id: empIdParam, relationship: d.relation, insured_name: d.dependent_name,
      gender: d.gender, date_of_birth: d.date_of_birth, age_as_on_doj: a,
      sum_insured: si, annual_premium: p, coverage_days: 365, prorated_premium: p,
    });
  }
  const totalPremium = insuredRows.reduce((s, r) => s + r.annual_premium, 0);

  const nowIso = new Date().toISOString();
  const enrollPayload = {
    emp_id: empIdParam, emp_name: emp.emp_name, department: emp.department,
    designation: emp.designation, date_of_joining: emp.gmc_inclusion_date,
    email_id: emp.email_id, mobile_number: emp.mobile_number,
    selected_sum_insured: si,
    enrollment_status: 'SUBMITTED', submitted_at: nowIso,
    terms_accepted: true, final_declaration_accepted: true,
    policy_year: RENEWAL_POLICY_YEAR,
    updated_at: nowIso,
  };
  const { data: enrollIns, error: enrollErr } = await supabase
    .from('employee_gmc_enrollment').insert(enrollPayload).select('enrollment_id').single();
  if (enrollErr) return res.status(400).json({ error: 'Submit failed: ' + enrollErr.message });

  const enrollment_id = enrollIns.enrollment_id;

  const insertRows = insuredRows.map(r => ({ ...r, enrollment_id }));
  const { error: insErr } = await supabase.from('employee_gmc_enrollment_insured').insert(insertRows);
  if (insErr) {
    await supabase.from('employee_gmc_enrollment').delete().eq('enrollment_id', enrollment_id);
    return res.status(500).json({ error: 'Failed to save insured members.' });
  }

  // ✅ FIX: 26-27 projected CTC from its own view; closing balance strictly from vw_employee_net_balance_2025_26
  const { data: calc26 } = await supabase
    .from('vw_employee_gmc_26_27_calc').select('ctc_gmc_26_27_projected').eq('emp_id', empIdParam).single();
  const { data: netBal26 } = await supabase
    .from('vw_employee_net_balance_2025_26').select('net_balance').eq('emp_id', empIdParam).single();
  const ctc = Number(calc26?.ctc_gmc_26_27_projected || 0);
  const closing = Math.round(Number(netBal26?.net_balance || 0));
  const net = closing + ctc - totalPremium;
  const refund_sep_26 = Math.max(0, Math.min(closing, net));
  const salary_deduction = Math.max(0, -net);

  try {
    await supabase.from('employee_gmc_enrollment_summary').upsert({
      enrollment_id, total_insurer_premium: totalPremium,
      total_ctc_gmc_available: ctc, salary_deduction,
      gmc_refund: refund_sep_26, updated_at: nowIso,
    }, { onConflict: 'enrollment_id' });
  } catch (e) {
    console.warn('[renewal] summary insert failed:', e.message);
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
    success: true,
    enrollment_id,
    total_premium_26_27: totalPremium,
    ctc_gmc_26_27: ctc,
    closing_balance_25_26: closing,
    refund_sep_2026: refund_sep_26,
    refund_sep_2027_estimate: Math.max(0, net - refund_sep_26),
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
    ? Math.round((totals.submitted / totals.total_eligible) * 100)
    : 0;

  res.json({ data, totals });
});

// ─── ADMIN: POST /api/renewal/admin/remind/:empId ─────────────────────────────
router.post('/admin/remind/:empId', async (req, res) => {
  if (!['admin','hr'].includes(req.user.role))
    return res.status(403).json({ error: 'Admin/HR only' });

  const empIdParam = req.params.empId.toUpperCase();
  if (!process.env.SUPABASE_URL)
    return res.status(500).json({ error: 'SUPABASE_URL not configured' });

  try {
    const r = await fetch(`${process.env.SUPABASE_URL}/functions/v1/send-renewal-reminders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY || ''}`,
      },
      body: JSON.stringify({
        secret: process.env.FUNCTION_SECRET || '',
        emp_ids: [empIdParam],
        triggered_by: req.user.full_name || req.user.emp_id || 'Admin',
        source: 'MANUAL',
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(400).json({ error: j.error || 'Reminder failed' });
    res.json({ success: true, ...j });
  } catch (e) {
    res.status(500).json({ error: 'Reminder failed: ' + e.message });
  }
});

// ─── ADMIN: POST /api/renewal/admin/pause/:empId ────────────────────────────
router.post('/admin/pause/:empId', async (req, res) => {
  if (!['admin','hr'].includes(req.user.role))
    return res.status(403).json({ error: 'Admin/HR only' });
  const { paused } = req.body || {};
  const empIdParam = req.params.empId.toUpperCase();
  const { error } = await supabase.from('renewal_monitor_2026_27')
    .update({ reminder_paused: !!paused, updated_at: new Date().toISOString() })
    .eq('emp_id', empIdParam);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true });
});

// ─── INTERNAL: POST /api/renewal/_track-login ──────────────────────────────────
router.post('/_track-login', async (req, res) => {
  const empIdParam = (req.user.emp_id || '').toUpperCase();
  if (!empIdParam) return res.json({ ok: true });
  const m = await supabase.from('renewal_monitor_2026_27')
    .select('first_logged_in_at, login_count').eq('emp_id', empIdParam).single();
  const now = new Date().toISOString();
  await bumpMonitor(empIdParam, {
    first_logged_in_at: m.data?.first_logged_in_at || now,
    last_logged_in_at: now,
    login_count: (m.data?.login_count || 0) + 1,
  });
  res.json({ ok: true });
});

// ✅ Export functions for initialization in main index.js
export default router;
export { initializeEnrollmentWindow, startEnrollmentWindowPolling };
