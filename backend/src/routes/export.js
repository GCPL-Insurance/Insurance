import { Router } from 'express';
import { supabase } from '../index.js';

const router = Router();

// ─── Export allowlists ─────────────────────────────────────────────────────────
// FIX: export.js now uses explicit allowlists so employees/hr can't export
// arbitrary tables like user_profiles. Role-scoped just like tables.js.

const EXPORTABLE_TABLES = {
  admin: new Set([
    'employee_onboarding', 'employees', 'employee_blood_group', 'dependents', 'insurance_dependents',
    'employee_gmc_enrollment', 'employee_gmc_enrollment_insured', 'employee_gmc_enrollment_summary',
    'employee_gmc_claims', 'employee_gmc_actual_deduction', 'employee_gmc_exit',
    'employee_gmc_financials_25_26', 'employee_gmc_net_balance', 'employee_gmc_opening_balance',
    'employee_ctc_gmc_increment', 'employee_health_checkups', 'employee_typhoid_vaccination',
    'insurance_cd_payments', 'insurance_enrollment_manual', 'policy_premium_details',
    'gmc_rate_cards', 'insurer_opening_balance', 'user_concerns',
  ]),
  hr: new Set([
    'employee_onboarding', 'employees', 'employee_blood_group', 'dependents', 'insurance_dependents',
    'employee_gmc_enrollment', 'employee_gmc_enrollment_insured', 'employee_gmc_enrollment_summary',
    'employee_gmc_claims', 'employee_gmc_actual_deduction', 'employee_gmc_exit',
    'employee_gmc_financials_25_26', 'employee_gmc_net_balance', 'employee_gmc_opening_balance',
    'employee_ctc_gmc_increment', 'employee_health_checkups', 'employee_typhoid_vaccination',
    'insurance_cd_payments', 'insurance_enrollment_manual', 'policy_premium_details',
    'gmc_rate_cards', 'user_concerns',
  ]),
  employee: new Set([
    'employee_gmc_enrollment', 'employee_gmc_enrollment_insured',
    'employee_gmc_claims', 'employee_gmc_actual_deduction',
    'employee_health_checkups', 'employee_typhoid_vaccination',
    'user_concerns',
  ]),
};

const EXPORTABLE_VIEWS = {
  admin: new Set([
    'vw_employee_ctc_gmc_total', 'vw_employee_dependent_premium', 'vw_employee_gmc_net_recoverable',
    'vw_employee_premium_total', 'vw_employee_with_claim_status', 'vw_gmc_emi_control',
    'vw_gmc_emi_ledger', 'vw_gmc_settlement', 'vw_insurance_coverage_days',
    'vw_insurance_dependents_control', 'vw_insurance_dependents_eligibility_status',
    'vw_typhoid_vaccination_status', 'vw_employee_latest_health_checkup',
    'vw_ff_base_employees', 'vw_ff_ctc_gmc_total', 'vw_ff_emi_recovered', 'vw_ff_insurance_days',
    'vw_gpa_addition', 'vw_gpa_deletion', 'vw_total_premium_exit_employee', 'vw_ctc_gmc_slab_timeline',
    'vw_gmc_claim_financial_summary', 'vw_gmc_claim_hospital_analysis',
    'vw_gmc_claim_summary_agewise', 'vw_gmc_claim_summary_disease_group',
    'vw_gmc_claim_summary_relationship', 'vw_gmc_policy_constants',
    'vw_insurance_addition_deletion_premium', 'vw_magma_insurance_addition_requests',
    'vw_magma_insurance_deletion_requests', 'vw_active_employees_missing_gpa',
  ]),
  hr: new Set([
    'vw_employee_ctc_gmc_total', 'vw_employee_dependent_premium', 'vw_employee_gmc_net_recoverable',
    'vw_employee_premium_total', 'vw_employee_with_claim_status', 'vw_gmc_emi_control',
    'vw_gmc_emi_ledger', 'vw_gmc_settlement', 'vw_insurance_coverage_days',
    'vw_insurance_dependents_control', 'vw_insurance_dependents_eligibility_status',
    'vw_typhoid_vaccination_status', 'vw_employee_latest_health_checkup',
    'vw_ff_base_employees', 'vw_ff_ctc_gmc_total', 'vw_ff_emi_recovered', 'vw_ff_insurance_days',
    'vw_gpa_addition', 'vw_gpa_deletion', 'vw_total_premium_exit_employee', 'vw_ctc_gmc_slab_timeline',
    'vw_gmc_claim_financial_summary', 'vw_gmc_claim_hospital_analysis',
    'vw_gmc_claim_summary_agewise', 'vw_gmc_claim_summary_disease_group',
    'vw_gmc_claim_summary_relationship', 'vw_gmc_policy_constants',
    'vw_insurance_addition_deletion_premium', 'vw_magma_insurance_addition_requests',
    'vw_magma_insurance_deletion_requests', 'vw_active_employees_missing_gpa',
  ]),
  employee: new Set([
    'vw_employee_ctc_gmc_total', 'vw_employee_dependent_premium', 'vw_employee_gmc_net_recoverable',
    'vw_employee_premium_total', 'vw_employee_with_claim_status', 'vw_gmc_emi_control',
    'vw_gmc_emi_ledger', 'vw_insurance_coverage_days', 'vw_insurance_dependents_control',
    'vw_insurance_dependents_eligibility_status', 'vw_typhoid_vaccination_status',
    'vw_employee_latest_health_checkup',
  ]),
};

// emp_id filter column per table
const EMP_FILTER_COL = {
  employee_gmc_claims: 'emp_id',
};

// ─── POST /api/export/table ───────────────────────────────────────────────────
router.post('/table', async (req, res) => {
  const { table, emp_filter, columns } = req.body;
  const { role, emp_id } = req.user;

  // FIX: Validate table against allowlist for this role
  const allowed = EXPORTABLE_TABLES[role];
  if (!allowed || !allowed.has(table)) {
    return res.status(403).json({ error: `Export not allowed for table: ${table}` });
  }

  // FIX: Validate columns if provided (no arbitrary SQL injection via column names)
  if (columns !== undefined) {
    if (!Array.isArray(columns) || columns.some(c => !/^[a-z_][a-z0-9_]*$/i.test(c))) {
      return res.status(400).json({ error: 'Invalid columns format. Must be an array of simple column names.' });
    }
  }

  const empFilterCol = EMP_FILTER_COL[table] || 'emp_id';
  let q = supabase.from(table).select(columns?.join(',') || '*').limit(5000);

  if (role === 'employee') {
    q = q.eq(empFilterCol, emp_id);
  } else if (emp_filter) {
    const searchVal = emp_filter.trim();
    q = q.ilike(empFilterCol, `%${searchVal}%`);
  }

  const { data, error } = await q;
  if (error) return res.status(400).json({ error: error.message });
  res.json({ data, count: data.length });
});

// ─── POST /api/export/view ────────────────────────────────────────────────────
router.post('/view', async (req, res) => {
  const { view, emp_filter } = req.body;
  const { role, emp_id } = req.user;

  // FIX: Validate view against allowlist for this role
  const allowed = EXPORTABLE_VIEWS[role];
  if (!allowed || !allowed.has(view)) {
    return res.status(403).json({ error: `Export not allowed for view: ${view}` });
  }

  let q = supabase.from(view).select('*').limit(5000);

  if (role === 'employee') {
    q = q.eq('emp_id', emp_id);
  } else if (emp_filter) {
    q = q.eq('emp_id', emp_filter.trim().toUpperCase());
  }

  const { data, error } = await q;
  if (error) return res.status(400).json({ error: error.message });
  res.json({ data, count: data.length });
});

export default router;
