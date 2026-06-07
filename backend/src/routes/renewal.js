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
// Helper: map a renewal_members_2026_27 DB row → shape the frontend expects.
// Frontend reads d.dependent_name, d.relation, d.action, d.delete_reason,
// d.edited, d.id, d.date_of_birth, d.gender (see renderRenewalDepCard in main.js).
// ─────────────────────────────────────────────────────────────────────────────
function mapDependentRow(row) {
  return {
    id:             row.id,
    emp_id:         row.emp_id,
    dependent_name: row.insured_name,
    insured_name:   row.insured_name,   // kept for backward-compat
    relation:       row.relationship,
    relationship:   row.relationship,   // kept for backward-compat
    gender:         row.gender,
    date_of_birth:  row.date_of_birth,
    action:         row.action || 'KEEP',
    delete_reason:  row.delete_reason || null,
    delete_remarks: row.delete_remarks || null,
    edited:         row.edited === true,
    is_locked:      row.is_locked === true,
  };
}

// Look up a member row by id and confirm the caller may act on it.
// Returns { row } on success or { error, status } on failure.
async function loadOwnedMember(req, memberId) {
  const { data: row, error } = await supabase
    .from('renewal_members_2026_27')
    .select('*')
    .eq('id', memberId)
    .single();
  if (error || !row) return { error: 'Dependent not found', status: 404 };
  if (!requireOwnEmpOrAdmin(req, row.emp_id)) return { error: 'Access denied', status: 403 };
  if (row.is_locked) return { error: 'This renewal has been submitted and can no longer be edited.', status: 409 };
  return { row };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/renewal/eligibility
// ─────────────────────────────────────────────────────────────────────────────
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

  // EXISTING vs NEW JOINEE — "already enrolled" = present in insurance_dependents.
  // Existing employees use the Renewal page; new joinees use the Enrollment form.
  const { data: existingMembers } = await supabase
    .from('insurance_dependents')
    .select('emp_id').eq('emp_id', empIdParam).eq('status', 'A').limit(1);
  const isExistingEmployee = !!(existingMembers && existingMembers.length > 0);

  // Previous (= current floor) sum insured
  const { data: siData } = await supabase
    .from('sum_insured_25_26')
    .select('sum_insured').eq('emp_id', empIdParam).maybeSingle();
  const previousSumInsured = Number(siData?.sum_insured) || 300000;

  // 25-26 financial figures
  const { data: bal } = await supabase
    .from('vw_employee_net_balance_2025_26')
    .select('total_ctc_gmc, opening_balance_24_25, total_premium, salary_gmc_deducted, net_balance')
    .eq('emp_id', empIdParam).maybeSingle();

  const calc = {
    ctc_gmc_25_26:           Number(bal?.total_ctc_gmc || 0),
    opening_balance_25_26:   Number(bal?.opening_balance_24_25 || 0),
    salary_deductions_25_26: Number(bal?.salary_gmc_deducted || 0),
    premium_25_26:           Number(bal?.total_premium || 0),
    closing_balance_25_26:   Number(bal?.net_balance || 0),
  };

  // Existing renewal (already submitted?)
  const { data: renewalEnroll } = await supabase
    .from('renewal_enrollment_2026_27')
    .select('enrollment_id, enrollment_status, submitted_at')
    .eq('emp_id', empIdParam).eq('policy_year', RENEWAL_POLICY_YEAR)
    .in('enrollment_status', ['SUBMITTED', 'APPROVED'])
    .order('submitted_at', { ascending: false, nullsFirst: false })
    .limit(1);

  // Track page visit for employees viewing their own renewal
  if (role === 'employee' && emp_id === empIdParam) {
    const { data: m } = await supabase
      .from('renewal_monitor_2026_27')
      .select('visited_renewal_page_at, page_visit_count').eq('emp_id', empIdParam).maybeSingle();
    await bumpMonitor(empIdParam, {
      visited_renewal_page_at: m?.visited_renewal_page_at || new Date().toISOString(),
      page_visit_count: (m?.page_visit_count || 0) + 1,
      email_id: emp.email_id,
      full_name: emp.emp_name,
    });
  }

  const availableSumInsured = SUM_INSURED_LADDER.filter(s => s >= previousSumInsured);

  res.json({
    eligible,
    is_existing_employee: isExistingEmployee,
    reason: !eligible
      ? (emp.is_active === false ? 'INACTIVE' : !emp.gmc_inclusion_date ? 'NO_GMC_INCLUSION_DATE' : 'UNKNOWN')
      : null,
    window: getEnrollmentWindow(),
    employee: emp,
    calc,
    current_sum_insured:   previousSumInsured,   // FE reads elig.current_sum_insured
    previous_sum_insured:  previousSumInsured,   // backward-compat
    available_sum_insured: availableSumInsured,
    existing_renewal: renewalEnroll?.[0] || null,
    validation_errors: [
      ...(!emp.mobile_number ? [{ field: 'mobile_number', message: 'Mobile number missing' }] : []),
      ...(!emp.email_id ? [{ field: 'email_id', message: 'Email missing' }] : []),
    ],
    policy_start_date: POLICY_START_DATE,
    policy_end_date:   POLICY_END_DATE,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/renewal/dependents/:empId   →  { data: [ ...mapped dependents ] }
// Excludes Self (Self is implicit; shown only in the premium quote).
// ─────────────────────────────────────────────────────────────────────────────
router.get('/dependents/:empId', async (req, res) => {
  const empIdParam = (req.params.empId || '').toString().toUpperCase();
  if (!empIdParam) return res.status(400).json({ error: 'emp_id required' });
  if (!requireOwnEmpOrAdmin(req, empIdParam)) return res.status(403).json({ error: 'Access denied' });

  const { data: rows, error } = await supabase
    .from('renewal_members_2026_27')
    .select('*')
    .eq('emp_id', empIdParam)
    .neq('relationship', 'Self')
    .order('relationship', { ascending: true });

  if (error) return res.status(400).json({ error: error.message });
  res.json({ data: (rows || []).map(mapDependentRow) });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/renewal/dependents/:empId   — ADD a newborn or newly-married spouse
// body: { addition_type:'NEWBORN'|'NEW_SPOUSE', insured_name, gender,
//         date_of_birth, relationship?, marriage_date? }
// Mid-term additions allowed only: Newborn ≤30 days from birth; Spouse ≤30 days
// from marriage (and spouse age ≥ 18, only one spouse).
// ─────────────────────────────────────────────────────────────────────────────
router.post('/dependents/:empId', async (req, res) => {
  const empIdParam = (req.params.empId || '').toString().toUpperCase();
  if (!empIdParam) return res.status(400).json({ error: 'emp_id required' });
  if (!requireOwnEmpOrAdmin(req, empIdParam)) return res.status(403).json({ error: 'Access denied' });

  // Block additions once the renewal is submitted (members locked)
  const { data: locked } = await supabase
    .from('renewal_members_2026_27')
    .select('id').eq('emp_id', empIdParam).eq('is_locked', true).limit(1);
  if (locked && locked.length) {
    return res.status(409).json({ error: 'Renewal already submitted; members can no longer be changed.' });
  }

  const b = req.body || {};
  const addition_type = b.addition_type;
  const name = (b.insured_name || '').toString().trim();
  const date_of_birth = b.date_of_birth;
  let relationship = b.relationship;

  if (!name) return res.status(400).json({ error: 'Name is required' });
  if (!date_of_birth) return res.status(400).json({ error: 'Date of birth is required' });

  const today = new Date();
  const daysSince = (d) => Math.floor((today - new Date(d)) / (1000 * 60 * 60 * 24));

  if (addition_type === 'NEWBORN') {
    if (!['Son', 'Daughter'].includes(relationship)) {
      return res.status(400).json({ error: 'Newborn must be added as Son or Daughter' });
    }
    const d = daysSince(date_of_birth);
    if (d < 0)  return res.status(400).json({ error: 'Birth date cannot be in the future' });
    if (d > NEWBORN_DAYS_LIMIT) {
      return res.status(400).json({ error: `A newborn can be added only within ${NEWBORN_DAYS_LIMIT} days of birth (${d} days have passed).` });
    }
  } else if (addition_type === 'NEW_SPOUSE') {
    relationship = 'Spouse';
    if (!b.marriage_date) return res.status(400).json({ error: 'Marriage date is required' });
    const md = daysSince(b.marriage_date);
    if (md < 0) return res.status(400).json({ error: 'Marriage date cannot be in the future' });
    if (md > NEW_SPOUSE_DAYS_LIMIT) {
      return res.status(400).json({ error: `A spouse can be added only within ${NEW_SPOUSE_DAYS_LIMIT} days of marriage (${md} days have passed).` });
    }
    // Match DB constraint chk_spouse_min_age: (CURRENT_DATE - dob) >= 6570 days (~18y)
    if (daysSince(date_of_birth) < 6570) {
      return res.status(400).json({ error: `Spouse must be at least ${MIN_SPOUSE_AGE} years old` });
    }
    const { data: spouse } = await supabase
      .from('renewal_members_2026_27')
      .select('id').eq('emp_id', empIdParam).eq('relationship', 'Spouse').eq('action', 'KEEP').limit(1);
    if (spouse && spouse.length) {
      return res.status(409).json({ error: 'A spouse already exists on this policy.' });
    }
  } else {
    return res.status(400).json({ error: 'addition_type must be NEWBORN or NEW_SPOUSE' });
  }

  const nowIso = new Date().toISOString();
  const payload = {
    emp_id: empIdParam,
    insured_name: name,
    relationship,
    gender: b.gender || null,
    date_of_birth,
    action: 'KEEP',
    new_addition: true,
    addition_type,
    addition_date: nowIso,
    marriage_date: addition_type === 'NEW_SPOUSE' ? b.marriage_date : null,
    marital_status: addition_type === 'NEW_SPOUSE' ? 'Married' : null,
    updated_at: nowIso,
  };

  const { data, error } = await supabase
    .from('renewal_members_2026_27').insert(payload).select('*').single();
  if (error) return res.status(400).json({ error: error.message });

  // If a spouse was added, reflect Married status on the Self row too.
  if (addition_type === 'NEW_SPOUSE') {
    await supabase.from('renewal_members_2026_27')
      .update({ marital_status: 'Married', updated_at: nowIso })
      .eq('emp_id', empIdParam).eq('relationship', 'Self');
  }

  res.json({ success: true, dependent: mapDependentRow(data) });
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/renewal/dependents/:id   body: { dependent_name, date_of_birth, gender }
// Edit typos only. Relation cannot change. Self cannot be edited here.
// ─────────────────────────────────────────────────────────────────────────────
router.patch('/dependents/:id', async (req, res) => {
  const { row, error, status } = await loadOwnedMember(req, req.params.id);
  if (error) return res.status(status).json({ error });
  if (row.relationship === 'Self') return res.status(400).json({ error: 'Self cannot be edited here' });

  const body = req.body || {};
  const update = { edited: true, updated_at: new Date().toISOString() };
  // Map FE field name → DB column, only for whitelisted fields.
  if (body.dependent_name !== undefined) update.insured_name = String(body.dependent_name).trim();
  if (body.insured_name  !== undefined) update.insured_name = String(body.insured_name).trim();
  if (body.date_of_birth !== undefined) update.date_of_birth = body.date_of_birth;
  if (body.gender        !== undefined) update.gender = body.gender || null;

  if (!update.insured_name && body.dependent_name !== undefined)
    return res.status(400).json({ error: 'Name cannot be empty' });

  // Re-validate child age if DOB changed
  if (update.date_of_birth && ['Son', 'Daughter'].includes(row.relationship)) {
    if (new Date(update.date_of_birth) <= new Date(CUTOFF_AGE_DATE)) {
      return res.status(400).json({ error: 'Child has completed 25 years on 24-JUL-2026 and is no longer eligible.' });
    }
  }
  if (update.date_of_birth && row.relationship === 'Spouse') {
    if (ageOnPolicyStart(update.date_of_birth) < MIN_SPOUSE_AGE) {
      return res.status(400).json({ error: `Spouse must be at least ${MIN_SPOUSE_AGE} years old` });
    }
  }

  const { error: upErr } = await supabase
    .from('renewal_members_2026_27').update(update).eq('id', row.id);
  if (upErr) return res.status(400).json({ error: upErr.message });
  res.json({ success: true, message: 'Dependent updated' });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/renewal/dependents/:id/delete   body: { reason }
// Soft delete: action='DELETE'. Self can never be deleted.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/dependents/:id/delete', async (req, res) => {
  const { row, error, status } = await loadOwnedMember(req, req.params.id);
  if (error) return res.status(status).json({ error });
  if (row.relationship === 'Self') return res.status(400).json({ error: 'Cannot delete Self' });

  const reason = (req.body?.reason || '').toString().toUpperCase();
  if (!DELETE_REASONS.has(reason)) {
    return res.status(400).json({ error: 'Invalid delete reason' });
  }

  const { error: upErr } = await supabase
    .from('renewal_members_2026_27')
    .update({ action: 'DELETE', delete_reason: reason, updated_at: new Date().toISOString() })
    .eq('id', row.id);
  if (upErr) return res.status(400).json({ error: upErr.message });
  res.json({ success: true, message: 'Dependent marked for deletion' });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/renewal/dependents/:id/restore
// ─────────────────────────────────────────────────────────────────────────────
router.post('/dependents/:id/restore', async (req, res) => {
  const { row, error, status } = await loadOwnedMember(req, req.params.id);
  if (error) return res.status(status).json({ error });

  const { error: upErr } = await supabase
    .from('renewal_members_2026_27')
    .update({ action: 'KEEP', delete_reason: null, delete_remarks: null, updated_at: new Date().toISOString() })
    .eq('id', row.id);
  if (upErr) return res.status(400).json({ error: upErr.message });
  res.json({ success: true, message: 'Dependent restored' });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2026-27 projected CTC GMC. Source: vw_renewal_ctc_gmc, which resolves
// latest employee_ctc_gmc_increment.new_ctc_gmc_per_month (else employees.ctc_gmc_per_month)
// and multiplies by 12. This is the FUTURE-period figure, NOT the 25-26 total.
async function fetchProjectedCtc2627(empIdParam) {
  const { data } = await supabase
    .from('vw_renewal_ctc_gmc')
    .select('ctc_gmc_26_27_projected, ctc_gmc_per_month')
    .eq('emp_id', empIdParam).maybeSingle();
  return {
    projected: Number(data?.ctc_gmc_26_27_projected || 0),
    perMonth:  Number(data?.ctc_gmc_per_month || 0),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared premium calculation. Self comes ONLY from the employee record;
// members table is queried with relationship != 'Self' to avoid double-counting.
// ─────────────────────────────────────────────────────────────────────────────
async function computeQuote(empIdParam, sumInsured) {
  const { data: emp } = await supabase
    .from('employees')
    .select('emp_id, emp_name, date_of_birth, gender').eq('emp_id', empIdParam).single();
  if (!emp) return { error: 'Employee not found', status: 404 };

  const { data: members } = await supabase
    .from('renewal_members_2026_27')
    .select('*').eq('emp_id', empIdParam).eq('action', 'KEEP')
    .neq('relationship', 'Self');               // ← prevents Self double-count

  const { data: rates } = await supabase
    .from('gmc_premium_rates_26_27').select('*').eq('sum_insured', sumInsured);
  if (!rates || rates.length === 0) return { error: 'Premium rates not configured', status: 400 };

  const findRate = (age) => {
    const r = rates.find(x => age >= x.age_min && age <= x.age_max);
    return r ? Number(r.annual_premium) : 0;
  };

  const selfAge = ageOnPolicyStart(emp.date_of_birth);
  const membersList = [{
    member_name: emp.emp_name, relation: 'Self', relationship: 'Self',
    age_at_policy_start: selfAge, annual_premium: findRate(selfAge),
  }];
  for (const m of (members || [])) {
    const age = ageOnPolicyStart(m.date_of_birth);
    membersList.push({
      member_name: m.insured_name, relation: m.relationship, relationship: m.relationship,
      age_at_policy_start: age, annual_premium: findRate(age),
    });
  }
  const totalPremium = membersList.reduce((s, m) => s + m.annual_premium, 0);

  const { data: bal } = await supabase
    .from('vw_employee_net_balance_2025_26')
    .select('net_balance').eq('emp_id', empIdParam).maybeSingle();
  const { projected: ctc } = await fetchProjectedCtc2627(empIdParam);  // 26-27 estimate (× 12)
  const closing = Number(bal?.net_balance || 0);
  const net     = closing + ctc - totalPremium;
  const refund_sep_26    = Math.max(0, Math.min(closing, net));
  const refund_sep_27    = Math.max(0, net - refund_sep_26);
  const salary_deduction = Math.max(0, -net);

  return {
    result: {
      sum_insured: sumInsured,
      members: membersList,
      total_premium_26_27: totalPremium,
      ctc_gmc_26_27: ctc,
      closing_balance_25_26: closing,
      refund_sep_2026: refund_sep_26,
      refund_sep_2027_estimate: refund_sep_27,
      salary_deduction_26_27: salary_deduction,
      emi_per_month_6mo: salary_deduction > 0 ? Math.round((salary_deduction / EMI_MONTHS) * 100) / 100 : 0,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/renewal/quote   body: { emp_id, sum_insured }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/quote', async (req, res) => {
  const empIdParam = (req.body?.emp_id || req.user.emp_id || '').toString().toUpperCase();
  const sumInsured = Number(req.body?.sum_insured);
  if (!empIdParam || !sumInsured) return res.status(400).json({ error: 'emp_id and sum_insured required' });
  if (!requireOwnEmpOrAdmin(req, empIdParam)) return res.status(403).json({ error: 'Access denied' });
  if (!SUM_INSURED_LADDER.includes(sumInsured)) return res.status(400).json({ error: 'Invalid sum_insured' });

  const { result, error, status } = await computeQuote(empIdParam, sumInsured);
  if (error) return res.status(status).json({ error });
  res.json(result);
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/renewal/submit   body: { emp_id, sum_insured, terms_accepted }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/submit', async (req, res) => {
  const empIdParam = (req.body?.emp_id || req.user.emp_id || '').toString().toUpperCase();
  const sumInsured = Number(req.body?.sum_insured);

  if (!empIdParam) return res.status(400).json({ error: 'emp_id required' });
  if (!requireOwnEmpOrAdmin(req, empIdParam)) return res.status(403).json({ error: 'Access denied' });
  if (!SUM_INSURED_LADDER.includes(sumInsured)) return res.status(400).json({ error: 'Invalid Sum Insured' });
  if (!isWindowOpen() && req.user.role === 'employee') {
    return res.status(409).json({ error: 'Renewal window is closed.' });
  }

  // No-decrease rule
  const { data: siData } = await supabase
    .from('sum_insured_25_26').select('sum_insured').eq('emp_id', empIdParam).maybeSingle();
  const previousSI = Number(siData?.sum_insured) || 300000;
  if (sumInsured < previousSI) {
    return res.status(400).json({ error: `Sum insured cannot be decreased from previous year (${previousSI}). Selected: ${sumInsured}` });
  }

  // Idempotency — already submitted?
  const { data: existing } = await supabase
    .from('renewal_enrollment_2026_27')
    .select('enrollment_id').eq('emp_id', empIdParam).eq('policy_year', RENEWAL_POLICY_YEAR)
    .in('enrollment_status', ['SUBMITTED', 'APPROVED']).limit(1);
  if (existing && existing.length > 0) {
    return res.status(409).json({ error: 'Renewal already submitted.' });
  }

  const { data: emp } = await supabase
    .from('employees')
    .select('emp_id, emp_name, date_of_birth, gender, email_id, mobile_number, designation, unit, department, gmc_inclusion_date')
    .eq('emp_id', empIdParam).single();
  if (!emp) return res.status(404).json({ error: 'Employee not found' });
  if (!emp.mobile_number || !emp.email_id) {
    return res.status(400).json({ error: 'Mobile number and email are required. Please contact HR.' });
  }

  const { data: keepMembers } = await supabase
    .from('renewal_members_2026_27')
    .select('*').eq('emp_id', empIdParam).eq('action', 'KEEP')
    .neq('relationship', 'Self');               // ← prevents Self double-count

  const { data: rates } = await supabase
    .from('gmc_premium_rates_26_27').select('*').eq('sum_insured', sumInsured);
  if (!rates || rates.length === 0) return res.status(400).json({ error: 'Premium rates not configured.' });
  const findRate = (age) => {
    const r = rates.find(x => age >= x.age_min && age <= x.age_max);
    return r ? Number(r.annual_premium) : 0;
  };

  const selfAge = ageOnPolicyStart(emp.date_of_birth);
  const insuredRows = [{
    emp_id: empIdParam, relationship: 'Self', insured_name: emp.emp_name, gender: emp.gender,
    date_of_birth: emp.date_of_birth, age_as_on_policy_start: selfAge, sum_insured: sumInsured,
    annual_premium: findRate(selfAge), coverage_days: 365, prorated_premium: findRate(selfAge),
  }];
  for (const m of (keepMembers || [])) {
    const age = ageOnPolicyStart(m.date_of_birth);
    const premium = findRate(age);
    insuredRows.push({
      emp_id: empIdParam, relationship: m.relationship, insured_name: m.insured_name, gender: m.gender,
      date_of_birth: m.date_of_birth, age_as_on_policy_start: age, sum_insured: sumInsured,
      annual_premium: premium, coverage_days: 365, prorated_premium: premium,
    });
  }
  const totalPremium = insuredRows.reduce((s, r) => s + r.annual_premium, 0);

  const nowIso = new Date().toISOString();
  const { data: enrollIns, error: enrollErr } = await supabase
    .from('renewal_enrollment_2026_27')
    .insert({
      emp_id: empIdParam, emp_name: emp.emp_name, department: emp.department, designation: emp.designation,
      date_of_joining: emp.gmc_inclusion_date, email_id: emp.email_id, mobile_number: emp.mobile_number,
      selected_sum_insured: sumInsured, enrollment_status: 'SUBMITTED', submitted_at: nowIso,
      locked_at: nowIso, terms_accepted: true, policy_year: RENEWAL_POLICY_YEAR, updated_at: nowIso,
    })
    .select('enrollment_id').single();
  if (enrollErr) return res.status(400).json({ error: 'Submit failed: ' + enrollErr.message });

  const enrollment_id = enrollIns.enrollment_id;
  const { error: insErr } = await supabase
    .from('renewal_enrollment_insured_2026_27')
    .insert(insuredRows.map(r => ({ ...r, enrollment_id })));
  if (insErr) {
    await supabase.from('renewal_enrollment_2026_27').delete().eq('enrollment_id', enrollment_id);
    return res.status(500).json({ error: 'Failed to save insured members: ' + insErr.message });
  }

  await supabase.from('renewal_members_2026_27')
    .update({ is_locked: true, enrollment_id, updated_at: nowIso }).eq('emp_id', empIdParam);

  const { data: bal } = await supabase
    .from('vw_employee_net_balance_2025_26')
    .select('net_balance').eq('emp_id', empIdParam).maybeSingle();
  const { projected: ctc } = await fetchProjectedCtc2627(empIdParam);  // 26-27 estimate (× 12)
  const closing = Number(bal?.net_balance || 0);
  const net     = closing + ctc - totalPremium;
  const refund_sep_26    = Math.max(0, Math.min(closing, net));
  const refund_sep_27    = Math.max(0, net - refund_sep_26);
  const salary_deduction = Math.max(0, -net);

  try {
    await supabase.from('renewal_enrollment_summary_2026_27').upsert({
      enrollment_id, emp_id: empIdParam, total_insurer_premium: totalPremium,
      total_ctc_gmc_available: ctc, closing_balance_25_26: closing, ctc_gmc_26_27_projected: ctc,
      salary_deduction, gmc_refund_sep_2026: refund_sep_26, gmc_refund_sep_2027_est: refund_sep_27,
      emi_per_month_6mo: salary_deduction > 0 ? Math.round((salary_deduction / EMI_MONTHS) * 100) / 100 : 0,
      calculated_at: nowIso, updated_at: nowIso,
    }, { onConflict: 'enrollment_id' });
  } catch (e) { console.warn('[renewal] Summary insert failed:', e.message); }

  await bumpMonitor(empIdParam, { submitted_at: nowIso, enrollment_id });

  res.json({
    success: true, enrollment_id, total_premium_26_27: totalPremium, ctc_gmc_26_27: ctc,
    closing_balance_25_26: closing, refund_sep_2026: refund_sep_26, refund_sep_2027_estimate: refund_sep_27,
    salary_deduction_26_27: salary_deduction,
    emi_per_month_6mo: salary_deduction > 0 ? Math.round((salary_deduction / EMI_MONTHS) * 100) / 100 : 0,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/renewal/_track-login   — fire-and-forget login-stage tracker
// ─────────────────────────────────────────────────────────────────────────────
router.post('/_track-login', async (req, res) => {
  const empIdParam = (req.user?.emp_id || '').toString().toUpperCase();
  if (!empIdParam || req.user.role !== 'employee') return res.json({ ok: true });
  await bumpMonitor(empIdParam, { last_logged_in_at: new Date().toISOString() });
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN: GET /api/renewal/admin/progress
// ─────────────────────────────────────────────────────────────────────────────
router.get('/admin/progress', async (req, res) => {
  if (!['admin', 'hr'].includes(req.user.role)) return res.status(403).json({ error: 'Admin/HR only' });

  const { data, error } = await supabase.from('vw_renewal_progress').select('*').order('emp_id');
  if (error) return res.status(400).json({ error: error.message });

  const rows = data || [];
  const totals = {
    total_eligible:         rows.length,
    submitted:              rows.filter(r => r.stage === 'SUBMITTED').length,
    visited_not_submitted:  rows.filter(r => r.stage === 'VISITED_NOT_SUBMITTED').length,
    logged_in_not_visited:  rows.filter(r => r.stage === 'LOGGED_IN_NOT_VISITED').length,
    never_logged_in:        rows.filter(r => r.stage === 'NEVER_LOGGED_IN').length,
  };
  totals.progress_percent = totals.total_eligible
    ? Math.round((totals.submitted / totals.total_eligible) * 100) : 0;

  res.json({ data: rows, totals });
});

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN: POST /api/renewal/admin/remind/:empId
// Increments the reminder counter. (Hook your mailer where indicated.)
// ─────────────────────────────────────────────────────────────────────────────
router.post('/admin/remind/:empId', async (req, res) => {
  if (!['admin', 'hr'].includes(req.user.role)) return res.status(403).json({ error: 'Admin/HR only' });
  const empIdParam = (req.params.empId || '').toString().toUpperCase();

  const { data: m } = await supabase
    .from('renewal_monitor_2026_27')
    .select('reminder_count, email_id, full_name').eq('emp_id', empIdParam).maybeSingle();

  // TODO: send the reminder email here via your Outlook SMTP mailer, e.g.
  //   await sendRenewalReminder(m?.email_id, m?.full_name);

  await bumpMonitor(empIdParam, {
    reminder_count: (m?.reminder_count || 0) + 1,
    last_reminded_at: new Date().toISOString(),
  });
  res.json({ success: true, message: 'Reminder recorded' });
});

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN: POST /api/renewal/admin/pause/:empId   body: { paused }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/admin/pause/:empId', async (req, res) => {
  if (!['admin', 'hr'].includes(req.user.role)) return res.status(403).json({ error: 'Admin/HR only' });
  const empIdParam = (req.params.empId || '').toString().toUpperCase();
  const paused = req.body?.paused === true;

  await bumpMonitor(empIdParam, { reminder_paused: paused });
  res.json({ success: true, paused });
});

export default router;
export { initializeEnrollmentWindow, startEnrollmentWindowPolling };
