// ═══════════════════════════════════════════════════════════════════════════════
// GMC Renewal 2026-27 routes
// Mounted at /api/renewal
// ═══════════════════════════════════════════════════════════════════════════════
import { Router } from 'express';
import { supabase } from '../index.js';

const router = Router();

// ─── Constants ────────────────────────────────────────────────────────────────
const RENEWAL_POLICY_YEAR    = '2026-27';
const RENEWAL_WINDOW_OPEN_AT = new Date('2026-07-01T00:00:00+05:30');
const RENEWAL_WINDOW_CLOSE_AT = new Date('2026-07-15T23:59:59+05:30');
const POLICY_START_DATE      = '2026-08-01';
const EMI_MONTHS             = 6;
const EMI_START_MONTH        = '2026-09';   // Sep 2026

const SUM_INSURED_LADDER = [200000, 300000, 400000, 500000, 600000, 700000, 1000000];
const EDITABLE_DEP_FIELDS = new Set(['dependent_name', 'date_of_birth', 'gender']);  // relation locked
const DELETE_REASONS = new Set(['EXPIRED', 'NOT_CONTINUING']);

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

function isWindowOpen() {
  const now = new Date();
  return now >= RENEWAL_WINDOW_OPEN_AT && now <= RENEWAL_WINDOW_CLOSE_AT;
}

function requireOwnEmpOrAdmin(req, empIdParam) {
  const { role, emp_id } = req.user;
  if (role === 'admin' || role === 'hr') return true;
  return role === 'employee' && emp_id === empIdParam;
}

// ─── Quietly track monitor activity ───────────────────────────────────────────
async function bumpMonitor(emp_id, fields) {
  if (!emp_id) return;
  try {
    const update = { ...fields, updated_at: new Date().toISOString() };
    // Use upsert in case the row wasn't seeded yet
    await supabase.from('renewal_monitor_2026_27')
      .upsert({ emp_id, ...update }, { onConflict: 'emp_id' });
  } catch (e) {
    console.warn('[renewal monitor bump failed]', e.message);
  }
}

// ─── GET /api/renewal/eligibility ─────────────────────────────────────────────
// Returns eligibility + base employee numbers for the renewal page.
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

  // 25-26 closing balance + 26-27 CTC GMC projected
  const { data: calc } = await supabase
    .from('vw_employee_gmc_26_27_calc')
    .select('*')
    .eq('emp_id', empIdParam)
    .single();

  // Current sum insured (from latest non-DRAFT enrollment)
  const { data: latestEnrolls } = await supabase
    .from('employee_gmc_enrollment')
    .select('selected_sum_insured, enrollment_status, submitted_at')
    .eq('emp_id', empIdParam)
    .in('enrollment_status', ['APPROVED', 'SUBMITTED'])
    .order('submitted_at', { ascending: false, nullsFirst: false })
    .limit(1);
  const currentSumInsured = Number(latestEnrolls?.[0]?.selected_sum_insured || 300000);

  // Has the employee already submitted a renewal for 26-27?
  const { data: renewalEnroll } = await supabase
    .from('employee_gmc_enrollment')
    .select('enrollment_id, enrollment_status, submitted_at')
    .eq('emp_id', empIdParam)
    .eq('policy_year', RENEWAL_POLICY_YEAR)
    .order('submitted_at', { ascending: false, nullsFirst: false })
    .limit(1);

  // Track that the renewal page was visited (if role is employee accessing own data)
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

  // Filter the SI ladder: hide options BELOW current SI (no downgrade allowed)
  const availableSumInsured = SUM_INSURED_LADDER.filter(s => s >= currentSumInsured);

  res.json({
    eligible,
    reason: !eligible
      ? (!emp.is_active ? 'INACTIVE' : !emp.gmc_inclusion_date ? 'NO_GMC_INCLUSION_DATE' : 'UNKNOWN')
      : null,
    window: {
      open_at:  RENEWAL_WINDOW_OPEN_AT.toISOString(),
      close_at: RENEWAL_WINDOW_CLOSE_AT.toISOString(),
      is_open:  isWindowOpen(),
    },
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
  res.json({ data: data || [] });
});


// ─── PATCH /api/renewal/dependents/:id — edit (name/DOB/gender) ───────────────
router.patch('/dependents/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

  // Lookup the row to enforce ownership and locked status
  const { data: row, error: fetchErr } = await supabase
    .from('renewal_dependents_2026_27')
    .select('*').eq('id', id).single();
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
    return res.status(400).json({ error: 'No editable fields provided. (Allowed: name, DOB, gender. Relation is locked.)' });

  updates.edited = true;
  updates.updated_at = new Date().toISOString();

  const { error: updErr } = await supabase
    .from('renewal_dependents_2026_27').update(updates).eq('id', id);
  if (updErr) return res.status(400).json({ error: updErr.message });

  res.json({ success: true });
});


// ─── POST /api/renewal/dependents/:id/delete — mark for deletion with reason ──
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
    .update({ action: 'DELETE', delete_reason: reason, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (updErr) return res.status(400).json({ error: updErr.message });

  res.json({ success: true });
});


// ─── POST /api/renewal/dependents/:id/restore — undo DELETE before submit ─────
router.post('/dependents/:id/restore', async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

  const { data: row, error: fetchErr } = await supabase
    .from('renewal_dependents_2026_27').select('*').eq('id', id).single();
  if (fetchErr || !row) return res.status(404).json({ error: 'Dependent not found' });
  if (!requireOwnEmpOrAdmin(req, row.emp_id)) return res.status(403).json({ error: 'Access denied' });
  if (row.is_locked) return res.status(409).json({ error: 'This row is locked.' });

  const { error: updErr } = await supabase
    .from('renewal_dependents_2026_27')
    .update({ action: 'KEEP', delete_reason: null, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (updErr) return res.status(400).json({ error: updErr.message });

  res.json({ success: true });
});


// ─── POST /api/renewal/quote — live premium quote (NOT a submission) ──────────
// Body: { emp_id, sum_insured }
router.post('/quote', async (req, res) => {
  const empIdParam = (req.body?.emp_id || req.user.emp_id || '').toString().toUpperCase();
  const sumInsured = Number(req.body?.sum_insured);
  if (!empIdParam) return res.status(400).json({ error: 'emp_id required' });
  if (!SUM_INSURED_LADDER.includes(sumInsured))
    return res.status(400).json({ error: `Invalid sum_insured. Allowed: ${SUM_INSURED_LADDER.join(', ')}` });
  if (!requireOwnEmpOrAdmin(req, empIdParam)) return res.status(403).json({ error: 'Access denied' });

  // Employee row (for self age + current SI)
  const { data: emp } = await supabase.from('employees')
    .select('emp_id, emp_name, date_of_birth, gender, gmc_inclusion_date')
    .eq('emp_id', empIdParam).single();
  if (!emp) return res.status(404).json({ error: 'Employee not found' });

  // Current SI (cannot decrease)
  const { data: latestEnrolls } = await supabase
    .from('employee_gmc_enrollment')
    .select('selected_sum_insured').eq('emp_id', empIdParam)
    .in('enrollment_status', ['APPROVED', 'SUBMITTED'])
    .order('submitted_at', { ascending: false, nullsFirst: false }).limit(1);
  const currentSI = Number(latestEnrolls?.[0]?.selected_sum_insured || 300000);
  if (sumInsured < currentSI)
    return res.status(400).json({ error: `Sum Insured cannot be reduced from ₹${currentSI.toLocaleString('en-IN')}.` });

  // Active dependents from renewal table (action = KEEP)
  const { data: deps } = await supabase
    .from('renewal_dependents_2026_27').select('*').eq('emp_id', empIdParam).eq('action', 'KEEP');

  // Premium rates for the chosen SI
  const { data: rates } = await supabase
    .from('gmc_premium_rates_26_27').select('*').eq('sum_insured', sumInsured);
  if (!rates || rates.length === 0)
    return res.status(400).json({ error: 'Premium rates not configured for this Sum Insured. Contact HR.' });

  const findRate = (age) => {
    const r = rates.find(x => age >= x.age_min && age <= x.age_max);
    return r ? Number(r.annual_premium) : 0;
  };

  // Build member list: self + KEEP dependents
  const members = [];
  const selfAge = ageOnPolicyStart(emp.date_of_birth);
  members.push({
    member_name: emp.emp_name, relation: 'Self', dob: emp.date_of_birth, gender: emp.gender,
    age_at_policy_start: selfAge, sum_insured: sumInsured, annual_premium: findRate(selfAge),
  });
  for (const d of (deps || [])) {
    const a = ageOnPolicyStart(d.date_of_birth);
    members.push({
      id: d.id, member_name: d.dependent_name, relation: d.relation, dob: d.date_of_birth,
      gender: d.gender, age_at_policy_start: a, sum_insured: sumInsured, annual_premium: findRate(a),
    });
  }
  const total_premium_26_27 = members.reduce((s, m) => s + (m.annual_premium || 0), 0);

  // Pull CTC GMC and 25-26 closing from the calc view
  const { data: calc } = await supabase
    .from('vw_employee_gmc_26_27_calc').select('*').eq('emp_id', empIdParam).single();

  const ctc_gmc_26_27 = Number(calc?.ctc_gmc_26_27_projected || 0);
  const closing_25_26 = Number(calc?.closing_balance_25_26 || 0);

  const net = closing_25_26 + ctc_gmc_26_27 - total_premium_26_27;
  const refund_sep_2026 = Math.max(0, Math.min(closing_25_26, net));
  const refund_sep_2027_est = Math.max(0, net - refund_sep_2026);
  const salary_deduction = Math.max(0, -net);
  const emi_per_month = Math.round((salary_deduction / EMI_MONTHS) * 100) / 100;

  res.json({
    emp_id: empIdParam,
    sum_insured: sumInsured,
    members,
    total_premium_26_27,
    ctc_gmc_26_27,
    closing_balance_25_26: closing_25_26,
    net_balance: net,
    refund_sep_2026,
    refund_sep_2027_estimate: refund_sep_2027_est,
    salary_deduction_26_27: salary_deduction,
    emi_per_month_6mo: emi_per_month,
    emi_start_month: EMI_START_MONTH,
    disclaimers: [
      'Premium is approximate and may vary ±10% based on final policy booking with the insurer.',
      'Sep-27 refund is an estimate and depends on 2027-28 increment and enrollment.',
    ],
  });
});


// ─── POST /api/renewal/submit ─────────────────────────────────────────────────
// Body: { emp_id, sum_insured, terms_accepted: true }
router.post('/submit', async (req, res) => {
  const { emp_id: bodyEmp, sum_insured, terms_accepted } = req.body || {};
  const empIdParam = (bodyEmp || req.user.emp_id || '').toString().toUpperCase();
  const sumInsured = Number(sum_insured);

  if (!empIdParam) return res.status(400).json({ error: 'emp_id required' });
  if (!requireOwnEmpOrAdmin(req, empIdParam)) return res.status(403).json({ error: 'Access denied' });
  if (!terms_accepted) return res.status(400).json({ error: 'You must accept the terms & conditions to submit.' });
  if (!SUM_INSURED_LADDER.includes(sumInsured))
    return res.status(400).json({ error: 'Invalid Sum Insured' });
  if (!isWindowOpen() && req.user.role === 'employee')
    return res.status(409).json({ error: 'Renewal window is closed.' });

  // Validate SI not decreased
  const { data: latestEnrolls } = await supabase
    .from('employee_gmc_enrollment').select('selected_sum_insured').eq('emp_id', empIdParam)
    .in('enrollment_status', ['APPROVED','SUBMITTED'])
    .order('submitted_at', { ascending: false, nullsFirst: false }).limit(1);
  const currentSI = Number(latestEnrolls?.[0]?.selected_sum_insured || 300000);
  if (sumInsured < currentSI)
    return res.status(400).json({ error: `Sum Insured cannot be reduced from ₹${currentSI.toLocaleString('en-IN')}.` });

  // Reject duplicate submission for 26-27
  const { data: existing } = await supabase
    .from('employee_gmc_enrollment').select('enrollment_id, enrollment_status')
    .eq('emp_id', empIdParam).eq('policy_year', RENEWAL_POLICY_YEAR)
    .in('enrollment_status', ['SUBMITTED','APPROVED']).limit(1);
  if (existing && existing.length > 0)
    return res.status(409).json({ error: 'Renewal already submitted. Contact HR if you need changes.' });

  // Get employee + KEEP dependents + premium rates
  const { data: emp } = await supabase.from('employees')
    .select('emp_id, emp_name, date_of_birth, gender, email_id, mobile_number, designation, unit, department, gmc_inclusion_date')
    .eq('emp_id', empIdParam).single();
  if (!emp) return res.status(404).json({ error: 'Employee not found' });

  const { data: keepDeps } = await supabase
    .from('renewal_dependents_2026_27').select('*').eq('emp_id', empIdParam).eq('action', 'KEEP');
  const { data: rates } = await supabase
    .from('gmc_premium_rates_26_27').select('*').eq('sum_insured', sumInsured);
  if (!rates || rates.length === 0)
    return res.status(400).json({ error: 'Premium rates not configured. Contact HR.' });

  const findRate = (age) => {
    const r = rates.find(x => age >= x.age_min && age <= x.age_max);
    return r ? Number(r.annual_premium) : 0;
  };

  // Build insured members rows
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
  // Insert the renewal enrollment row
  const enrollPayload = {
    emp_id: empIdParam, emp_name: emp.emp_name, department: emp.department,
    designation: emp.designation, date_of_joining: emp.gmc_inclusion_date,
    email_id: emp.email_id, mobile_number: emp.mobile_number,
    selected_sum_insured: sumInsured,
    enrollment_status: 'SUBMITTED', submitted_at: nowIso,
    terms_accepted: true, final_declaration_accepted: true,
    policy_year: RENEWAL_POLICY_YEAR,
    updated_at: nowIso,
  };
  const { data: enrollIns, error: enrollErr } = await supabase
    .from('employee_gmc_enrollment').insert(enrollPayload).select('enrollment_id').single();
  if (enrollErr) return res.status(400).json({ error: 'Submit failed: ' + enrollErr.message });

  const enrollment_id = enrollIns.enrollment_id;

  // Insert insured members
  const insertRows = insuredRows.map(r => ({ ...r, enrollment_id }));
  const { error: insErr } = await supabase.from('employee_gmc_enrollment_insured').insert(insertRows);
  if (insErr) {
    console.error('[renewal/submit] insured insert failed:', insErr.message);
    return res.status(500).json({ error: 'Failed to save insured members: ' + insErr.message });
  }

  // Insert summary row
  const { data: calc } = await supabase
    .from('vw_employee_gmc_26_27_calc').select('*').eq('emp_id', empIdParam).single();
  const ctc = Number(calc?.ctc_gmc_26_27_projected || 0);
  const closing = Number(calc?.closing_balance_25_26 || 0);
  const net = closing + ctc - totalPremium;
  const refund_sep_26 = Math.max(0, Math.min(closing, net));
  const salary_deduction = Math.max(0, -net);

  await supabase.from('employee_gmc_enrollment_summary').upsert({
    enrollment_id,
    total_insurer_premium: totalPremium,
    total_ctc_gmc_available: ctc,
    salary_deduction: salary_deduction,
    gmc_refund: refund_sep_26,
    updated_at: nowIso,
  }, { onConflict: 'enrollment_id' });

  // Lock all renewal_dependents_2026_27 rows for this employee + tag enrollment_id
  await supabase.from('renewal_dependents_2026_27')
    .update({ is_locked: true, enrollment_id, updated_at: nowIso })
    .eq('emp_id', empIdParam);

  // Mark monitor row
  await bumpMonitor(empIdParam, { submitted_at: nowIso, enrollment_id });

  // Fire confirmation email (non-blocking)
  if (process.env.SUPABASE_URL) {
    fetch(`${process.env.SUPABASE_URL}/functions/v1/send-renewal-confirmation`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY || ''}`,
      },
      body: JSON.stringify({ enrollment_id, emp_id: empIdParam, secret: process.env.FUNCTION_SECRET || '' }),
    }).catch(e => console.warn('[renewal/submit] confirmation email failed:', e.message));
  }

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

  // Summary stats
  const totals = {
    total_eligible:        data.length,
    submitted:             data.filter(r => r.stage === 'SUBMITTED').length,
    visited_not_submitted: data.filter(r => r.stage === 'VISITED_NOT_SUBMITTED').length,
    logged_in_not_visited: data.filter(r => r.stage === 'LOGGED_IN_NOT_VISITED').length,
    never_logged_in:       data.filter(r => r.stage === 'NEVER_LOGGED_IN').length,
  };
  totals.progress_percent = totals.total_eligible
    ? Math.round((totals.submitted / totals.total_eligible) * 100)
    : 0;

  res.json({ data, totals });
});


// ─── ADMIN: POST /api/renewal/admin/remind/:empId — send manual reminder ──────
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


// ─── ADMIN: POST /api/renewal/admin/pause/:empId ──────────────────────────────
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


// ─── INTERNAL: POST /api/renewal/_track-login ─────────────────────────────────
// Called from the auth flow / frontend after a successful login.
router.post('/_track-login', async (req, res) => {
  const empIdParam = (req.user.emp_id || '').toUpperCase();
  if (!empIdParam) return res.json({ ok: true });
  const m = await supabase.from('renewal_monitor_2026_27')
    .select('first_logged_in_at, login_count').eq('emp_id', empIdParam).single();
  const now = new Date().toISOString();
  await bumpMonitor(empIdParam, {
    first_logged_in_at: m.data?.first_logged_in_at || now,
    last_logged_in_at:  now,
    login_count:        (m.data?.login_count || 0) + 1,
  });
  res.json({ ok: true });
});


export default router;
