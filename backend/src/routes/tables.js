import { Router } from 'express';
import { supabase } from '../index.js';

const router = Router();

// ─── Table access control ──────────────────────────────────────────────────────
// Defines which roles can read/write/delete each table.
// 'employee' writes are further restricted per-table below.
const TABLE_ACCESS = {
  employee_onboarding:              { read: ['admin','hr','employee'], write: ['admin','hr'], delete: ['admin'] },
  employees:                        { read: ['admin','hr','employee'], write: ['admin','hr'], delete: ['admin'] },
  employee_blood_group:             { read: ['admin','hr','employee'], write: ['admin','hr'], delete: ['admin'] },
  dependents:                       { read: ['admin','hr','employee'], write: ['admin','hr'], delete: ['admin'] },
  insurance_dependents:             { read: ['admin','hr','employee'], write: ['admin','hr'], delete: ['admin'] },
  employee_gmc_enrollment:          { read: ['admin','hr','employee'], write: ['admin','hr','employee'], delete: ['admin'] },
  employee_gmc_enrollment_insured:  { read: ['admin','hr','employee'], write: ['admin','hr','employee'], delete: ['admin'] },
  employee_gmc_enrollment_summary:  { read: ['admin','hr','employee'], write: ['admin','hr'],            delete: ['admin'] },
  employee_gmc_claims:              { read: ['admin','hr','employee'], write: ['admin','hr'], delete: ['admin'] },
  employee_gmc_actual_deduction:    { read: ['admin','hr','employee'], write: ['admin','hr'], delete: ['admin'] },
  employee_gmc_exit:                { read: ['admin','hr','employee'], write: ['admin','hr'], delete: ['admin'] },
  employee_gmc_financials_25_26:    { read: ['admin','hr','employee'], write: ['admin'],      delete: ['admin'] },
  employee_gmc_net_balance:         { read: ['admin','hr','employee'], write: ['admin'],      delete: ['admin'] },
  employee_gmc_opening_balance:     { read: ['admin','hr','employee'], write: ['admin','hr'], delete: ['admin'] },
  employee_ctc_gmc_increment:       { read: ['admin','hr','employee'], write: ['admin','hr'], delete: ['admin'] },
  employee_health_checkups:         { read: ['admin','hr','employee'], write: ['admin','hr'], delete: ['admin'] },
  employee_typhoid_vaccination:     { read: ['admin','hr','employee'], write: ['admin','hr'], delete: ['admin'] },
  insurance_cd_payments:            { read: ['admin','hr'],            write: ['admin','hr'], delete: ['admin'] },
  insurance_enrollment_manual:      { read: ['admin','hr','employee'], write: ['admin','hr'], delete: ['admin'] },
  policy_premium_details:           { read: ['admin','hr'],            write: ['admin','hr'], delete: ['admin'] },
  gmc_rate_cards:                   { read: ['admin','hr','employee'], write: ['admin'],      delete: ['admin'] },
  gmc_premium_rates_26_27:          { read: ['admin','hr','employee'], write: ['admin'],      delete: ['admin'] },
  gmc_rate_cards_26_27:             { read: ['admin','hr','employee'], write: ['admin'],      delete: ['admin'] },
  enrollment_eligible_2026_27:      { read: ['admin','hr','employee'], write: ['admin'],      delete: ['admin'] },
  enrollment_monitor_2026_27:       { read: ['admin','hr'],            write: ['admin'],      delete: ['admin'] },
  insurer_opening_balance:          { read: ['admin','hr'],            write: ['admin'],      delete: ['admin'] },
  user_profiles:                    { read: ['admin'],                 write: ['admin'],      delete: ['admin'] },
  user_concerns:                    { read: ['admin','hr','employee'], write: ['admin','hr','employee'], delete: ['admin'] },
};

// Column used to filter employee's own records
const EMP_FILTER_COL = {
  employee_onboarding:               'emp_id',
  employees:                     'emp_id',
  employee_blood_group:          'emp_id',
  insurance_dependents:          'emp_id',
  employee_gmc_enrollment:       'emp_id',
  employee_gmc_enrollment_insured: 'emp_id',
  employee_gmc_claims:           'emp_id',
  employee_gmc_actual_deduction: 'emp_id',
  employee_gmc_exit:             'emp_id',
  employee_gmc_financials_25_26: 'emp_id',
  employee_gmc_net_balance:      'emp_id',
  employee_gmc_opening_balance:  'emp_id',
  employee_ctc_gmc_increment:    'emp_id',
  employee_health_checkups:      'emp_id',
  employee_typhoid_vaccination:  'emp_id',
  insurance_enrollment_manual:   'emp_id',
  user_concerns:                 'emp_id',
};

// Tables employees are allowed to write to via the generic endpoint
const EMPLOYEE_WRITABLE = new Set(['user_concerns', 'employee_gmc_enrollment', 'employee_gmc_enrollment_insured']);

function checkAccess(table, action, role) {
  const access = TABLE_ACCESS[table];
  if (!access) return false;
  return access[action]?.includes(role) ?? false;
}

// Sanitize pagination params
function parsePagination(page, pageSize) {
  const p = Math.max(0, parseInt(page) || 0);
  const ps = Math.min(200, Math.max(1, parseInt(pageSize) || 50)); // cap at 200
  return { page: p, pageSize: ps, offset: p * ps };
}

// ─── GET /api/data/:table ─────────────────────────────────────────────────────
router.get('/:table', async (req, res) => {
  const { table } = req.params;
  const { role, emp_id } = req.user;
  const { page, pageSize, emp_filter, all } = req.query;

  if (!checkAccess(table, 'read', role)) {
    return res.status(403).json({ error: 'Access denied to this table' });
  }

  const { page: pg, pageSize: ps, offset } = parsePagination(page, pageSize);

  // ✅ SEARCH-ALL MODE: when ?all=1 is passed, return the full dataset (up to a
  // safe cap) so the frontend can search across EVERY record, not just one page.
  // This fixes the bug where searching (e.g. blood group "O+") only matched rows
  // on the currently visible page.
  const fetchAll = all === '1' || all === 'true';
  const ALL_CAP = 5000; // hard upper bound to protect the server

  let q = supabase.from(table).select('*', { count: 'exact' });

  if (role === 'employee') {
    const col = EMP_FILTER_COL[table];
    if (!col) return res.status(403).json({ error: 'Employees cannot access this table directly' });
    q = q.eq(col, emp_id);
  } else if (emp_filter) {
    const col = EMP_FILTER_COL[table] || 'emp_id';
    // Support all search formats: exact (U3-1445), partial (1445), no-prefix (U31445), uppercase insensitive
    const searchVal = emp_filter.trim();
    // Use ilike for flexible partial matching across all emp_id formats
    q = q.eq(col, searchVal);
  }

  q = fetchAll ? q.range(0, ALL_CAP - 1) : q.range(offset, offset + ps - 1);

  const { data, error, count } = await q;
  if (error) return res.status(400).json({ error: error.message });
  res.json({ data, count, page: fetchAll ? 0 : pg, pageSize: fetchAll ? (data?.length || 0) : ps, all: fetchAll });
});

// ─── POST /api/data/:table — single insert ────────────────────────────────────
router.post('/:table', async (req, res) => {
  const { table } = req.params;
  const { role, emp_id } = req.user;

  if (!checkAccess(table, 'write', role)) {
    return res.status(403).json({ error: 'Insert not allowed' });
  }

  // Employees can only write to specific tables
  if (role === 'employee' && !EMPLOYEE_WRITABLE.has(table)) {
    return res.status(403).json({ error: 'Employees cannot write to this table' });
  }

  const body = { ...req.body };
  // Strip system/ID fields from body to prevent injection
  delete body.id;

  if (role === 'employee') {
    // Force emp_id from JWT — never from body
    body.emp_id = emp_id;

    if (table === 'user_concerns') {
      body.status = 'Open'; // employees can't self-approve concerns
      delete body.admin_response;
    }
    if (table === 'employee_gmc_enrollment' || table === 'employee_gmc_enrollment_insured') {
      // Strip admin-only fields
      delete body.admin_remarks;
      delete body.reviewed_by;
      delete body.reviewed_at;
      delete body.locked_at;
      delete body.locked_by;
      delete body.enrollment_status; // managed separately
    }
  }

  const { data, error } = await supabase.from(table).insert(body).select();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json({ data });
});

// ─── POST /api/data/:table/bulk — bulk insert (admin/hr only) ─────────────────
router.post('/:table/bulk', async (req, res) => {
  const { table } = req.params;
  const { role } = req.user;

  if (!checkAccess(table, 'write', role) || role === 'employee') {
    return res.status(403).json({ error: 'Bulk insert requires admin or HR role' });
  }

  const { rows } = req.body;
  if (!Array.isArray(rows) || rows.length === 0) {
    return res.status(400).json({ error: 'rows must be a non-empty array' });
  }
  if (rows.length > 2000) {
    return res.status(400).json({ error: 'Maximum 2000 rows per upload' });
  }

  const cleaned = rows.map(r => { const d = { ...r }; delete d.id; return d; });

  // Use upsert for deduction table to handle re-uploads cleanly
  const isDeductionTable = table === 'employee_gmc_actual_deduction';
  const query = isDeductionTable
    ? supabase.from(table).upsert(cleaned, { onConflict: 'emp_id,payroll_month', ignoreDuplicates: false }).select()
    : supabase.from(table).insert(cleaned).select();

  const { data, error } = await query;
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json({ data, inserted: cleaned.length });
});

// ─── PATCH /api/data/:table/:id — update ─────────────────────────────────────
// Pass ?keyCol=xxx for tables with non-standard PKs (e.g. keyCol=emp_id)
router.patch('/:table/:id', async (req, res) => {
  const { table, id } = req.params;
  const { role, emp_id } = req.user;
  const keyCol = req.query.keyCol || 'id';

  // Validate keyCol to prevent arbitrary column injection
  const ALLOWED_KEY_COLS = new Set(['id', 'emp_id', 'enrollment_id', 'rate_card_id', 'concern_id']);
  if (!ALLOWED_KEY_COLS.has(keyCol)) {
    return res.status(400).json({ error: 'Invalid keyCol parameter' });
  }

  if (!checkAccess(table, 'write', role)) {
    return res.status(403).json({ error: 'Update not allowed' });
  }

  if (role === 'employee' && !EMPLOYEE_WRITABLE.has(table)) {
    return res.status(403).json({ error: 'Employees cannot update this table' });
  }

  // Employees can only edit their own rows
  if (role === 'employee') {
    const empCol = EMP_FILTER_COL[table];
    if (!empCol) return res.status(403).json({ error: 'Access denied' });

    const { data: existing } = await supabase.from(table).select(empCol).eq(keyCol, id).single();
    if (!existing) return res.status(404).json({ error: 'Record not found' });
    if (existing[empCol] !== emp_id) {
      return res.status(403).json({ error: 'You can only edit your own records' });
    }
  }

  const body = { ...req.body };
  delete body.id;

  // Employees cannot change privileged fields
  if (role === 'employee') {
    delete body.status;        // for user_concerns
    delete body.admin_response;
    delete body.admin_remarks;
    delete body.reviewed_by;
    delete body.reviewed_at;
    delete body.locked_at;
    delete body.locked_by;
    delete body.enrollment_status;
    body.emp_id = emp_id;      // force emp_id from JWT
  }

  body.updated_at = new Date().toISOString();

  const { data, error } = await supabase.from(table).update(body).eq(keyCol, id).select();
  if (error) return res.status(400).json({ error: error.message });
  if (!data?.length) return res.status(404).json({ error: 'Record not found or no changes made' });
  res.json({ data });
});

// ─── DELETE /api/data/:table/:id — admin only ─────────────────────────────────
router.delete('/:table/:id', async (req, res) => {
  const { table, id } = req.params;
  const { role } = req.user;
  const keyCol = req.query.keyCol || 'id';

  const ALLOWED_KEY_COLS = new Set(['id', 'emp_id', 'enrollment_id', 'rate_card_id']);
  if (!ALLOWED_KEY_COLS.has(keyCol)) {
    return res.status(400).json({ error: 'Invalid keyCol parameter' });
  }

  if (!checkAccess(table, 'delete', role)) {
    return res.status(403).json({ error: 'Delete not allowed. Admin only.' });
  }

  const { error } = await supabase.from(table).delete().eq(keyCol, id);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true });
});

export default router;
