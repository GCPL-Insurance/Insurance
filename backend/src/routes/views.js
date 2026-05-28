import { Router } from 'express';
import { supabase } from '../index.js';

const router = Router();

// ─── View access metadata ──────────────────────────────────────────────────────
// empFilter: true = employees see only their own rows; hr/admin can emp_filter
// minRole:   minimum role required to access this view
const VIEW_META = {
  vw_active_employees_missing_gpa:            { empFilter: true,  minRole: 'hr' },
  vw_ctc_gmc_slab_timeline:                   { empFilter: true,  minRole: 'hr' },
  vw_employee_blood_group_status:             { empFilter: true,  minRole: 'employee' },
  vw_employee_ctc_gmc_total:                  { empFilter: true,  minRole: 'employee' },
  vw_employee_dependent_premium:              { empFilter: true,  minRole: 'employee' },
  vw_employee_gmc_net_recoverable:            { empFilter: true,  minRole: 'employee' },
  vw_employee_latest_health_checkup:          { empFilter: true,  minRole: 'employee' },
  vw_employee_premium_total:                  { empFilter: true,  minRole: 'employee' },
  vw_employee_with_claim_status:              { empFilter: true,  minRole: 'employee' },
  vw_ff_base_employees:                       { empFilter: true,  minRole: 'hr' },
  vw_ff_ctc_gmc_total:                        { empFilter: true,  minRole: 'hr' },
  vw_ff_emi_recovered:                        { empFilter: true,  minRole: 'hr' },
  vw_ff_insurance_days:                       { empFilter: true,  minRole: 'hr' },
  vw_gmc_claim_financial_summary:             { empFilter: false, minRole: 'hr' },
  vw_gmc_claim_hospital_analysis:             { empFilter: false, minRole: 'hr' },
  vw_gmc_claim_summary_agewise:               { empFilter: false, minRole: 'hr' },
  vw_gmc_claim_summary_disease_group:         { empFilter: false, minRole: 'hr' },
  vw_gmc_claim_summary_relationship:          { empFilter: false, minRole: 'hr' },
  vw_gmc_emi_control:                         { empFilter: true,  minRole: 'employee' },
  vw_gmc_emi_ledger:                          { empFilter: true,  minRole: 'employee' },
  vw_gmc_policy_constants:                    { empFilter: false, minRole: 'hr' },
  vw_gmc_settlement:                          { empFilter: true,  minRole: 'hr' },
  vw_gmc_statement_required:                  { empFilter: true,  minRole: 'hr' },
  vw_gpa_addition:                            { empFilter: true,  minRole: 'hr' },
  vw_gpa_deletion:                            { empFilter: true,  minRole: 'hr' },
  vw_insurance_addition_deletion_premium:     { empFilter: false, minRole: 'hr' },
  vw_insurance_coverage_days:                 { empFilter: true,  minRole: 'employee' },
  vw_insurance_dependents_control:            { empFilter: true,  minRole: 'employee' },
  vw_insurance_dependents_eligibility_status: { empFilter: true,  minRole: 'employee' },
  vw_magma_insurance_addition_requests:       { empFilter: false, minRole: 'hr' },
  vw_magma_insurance_deletion_requests:       { empFilter: false, minRole: 'hr' },
  vw_total_premium_exit_employee:             { empFilter: true,  minRole: 'hr' },
  vw_typhoid_vaccination_status:              { empFilter: true,  minRole: 'employee' },
};

const ROLE_RANK = { employee: 0, hr: 1, admin: 2 };

// ─── GET /api/views/employee-full/:empId ─────────────────────────────────────
// Master employee report — MUST be defined BEFORE /:viewName
router.get('/employee-full/:empId', async (req, res) => {
  const { empId } = req.params;
  const { role, emp_id } = req.user;

  // Validate empId format (alphanumeric, reasonable length)
  if (!/^[A-Z0-9][A-Z0-9\-]{0,19}$/.test(empId.toUpperCase())) {
    return res.status(400).json({ error: 'Invalid empId format' });
  }

  // Employee can only see their own data
  if (role === 'employee' && emp_id !== empId.toUpperCase()) {
    return res.status(403).json({ error: 'Access denied' });
  }
  if (!['admin', 'hr', 'employee'].includes(role)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const empIdNorm = empId.toUpperCase();

  const tables = [
    { name: 'employees',                     col: 'emp_id' },
    { name: 'employee_onboarding',           col: 'emp_id' },
    { name: 'employee_blood_group',           col: 'emp_id' },
    { name: 'insurance_dependents',           col: 'emp_id' },
    { name: 'employee_gmc_enrollment',        col: 'emp_id' },
    { name: 'employee_gmc_claims',            col: 'emp_id' },
    { name: 'employee_ctc_gmc_increment',     col: 'emp_id' },
    { name: 'employee_gmc_actual_deduction',  col: 'emp_id' },
    { name: 'employee_health_checkups',       col: 'emp_id' },
    { name: 'employee_typhoid_vaccination',   col: 'emp_id' },
    { name: 'employee_gmc_exit',              col: 'emp_id' },
    { name: 'employee_gmc_financials_25_26',  col: 'emp_id' },
    { name: 'employee_gmc_net_balance',       col: 'emp_id' },
    { name: 'employee_gmc_opening_balance',   col: 'emp_id' },
    { name: 'insurance_enrollment_manual',    col: 'emp_id' },
  ];

  const views = [
    'vw_employee_ctc_gmc_total', 'vw_employee_dependent_premium',
    'vw_employee_gmc_net_recoverable', 'vw_employee_premium_total',
    'vw_employee_with_claim_status', 'vw_gmc_emi_control',
    'vw_gmc_emi_ledger', 'vw_gmc_settlement', 'vw_insurance_coverage_days',
    'vw_insurance_dependents_control', 'vw_insurance_dependents_eligibility_status',
    'vw_typhoid_vaccination_status', 'vw_employee_latest_health_checkup',
    'vw_ff_base_employees', 'vw_ff_ctc_gmc_total', 'vw_ff_emi_recovered',
    'vw_ff_insurance_days', 'vw_gpa_addition', 'vw_gpa_deletion',
    'vw_total_premium_exit_employee', 'vw_ctc_gmc_slab_timeline',
  ];

  // Run all in parallel; isolate errors per source so one failure doesn't kill the whole response
  const [tableResults, viewResults] = await Promise.all([
    Promise.all(tables.map(t =>
      supabase.from(t.name).select('*').eq(t.col, empIdNorm)
        .then(r => ({ name: t.name, data: r.data || [], error: r.error?.message }))
        .catch(e => ({ name: t.name, data: [], error: e.message }))
    )),
    Promise.all(views.map(v =>
      supabase.from(v).select('*').eq('emp_id', empIdNorm)
        .then(r => ({ name: v, data: r.data || [], error: r.error?.message }))
        .catch(e => ({ name: v, data: [], error: e.message }))
    )),
  ]);

  const result = {};
  const errors = {};
  tableResults.forEach(r => {
    result[r.name] = r.data;
    if (r.error) errors[r.name] = r.error;
  });
  viewResults.forEach(r => {
    result[r.name] = r.data;
    if (r.error) errors[r.name] = r.error;
  });

  // Log server-side if any sub-fetches failed
  if (Object.keys(errors).length > 0) {
    console.warn(`[employee-full/${empIdNorm}] partial errors:`, errors);
  }

  res.json({ emp_id: empIdNorm, data: result, ...(Object.keys(errors).length ? { _errors: errors } : {}) });
});

// ─── GET /api/views/:viewName ─────────────────────────────────────────────────
// MUST be defined AFTER /employee-full/:empId to avoid shadowing
router.get('/:viewName', async (req, res) => {
  const { viewName } = req.params;
  const { role, emp_id } = req.user;
  const { emp_filter, page, pageSize, all } = req.query;

  const meta = VIEW_META[viewName];
  if (!meta) return res.status(404).json({ error: 'View not found' });

  if ((ROLE_RANK[role] ?? -1) < (ROLE_RANK[meta.minRole] ?? 99)) {
    return res.status(403).json({ error: `Access denied. Requires ${meta.minRole} role or higher.` });
  }

  const pg = Math.max(0, parseInt(page) || 0);
  const ps = Math.min(500, Math.max(1, parseInt(pageSize) || 100));
  const offset = pg * ps;

  // ✅ SEARCH-ALL MODE: ?all=1 returns the full view (up to cap) so the frontend
  // can search across every row, not just the current page.
  const fetchAll = all === '1' || all === 'true';
  const ALL_CAP = 5000;

  let q = supabase.from(viewName).select('*', { count: 'exact' });

  if (role === 'employee' && meta.empFilter) {
    q = q.eq('emp_id', emp_id);
  } else if (emp_filter && meta.empFilter) {
    q = q.eq('emp_id', emp_filter.trim().toUpperCase());
  }

  q = fetchAll ? q.range(0, ALL_CAP - 1) : q.range(offset, offset + ps - 1);

  const { data, error, count } = await q;
  if (error) return res.status(400).json({ error: error.message });
  res.json({ data, count, page: fetchAll ? 0 : pg, pageSize: fetchAll ? (data?.length || 0) : ps, all: fetchAll });
});

export default router;
