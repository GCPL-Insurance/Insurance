import { Router } from 'express';
import { supabase } from '../index.js';

const router = Router();

// ─── Role guard helper ────────────────────────────────────────────────────────
// /api/admin is accessible to both admin and hr (for enrollment review).
// User management routes below require the stricter admin-only check.
function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Access denied. Admin role required.' });
  }
  next();
}

const VALID_ROLES = ['admin', 'hr', 'employee'];

// ─── GET /api/admin/users ─────────────────────────────────────────────────────
router.get('/users', requireAdmin, async (req, res) => {
  const { data, error } = await supabase
    .from('user_profiles')
    .select('id, emp_id, email, full_name, role, is_active, created_at')
    .order('created_at', { ascending: false });
  if (error) return res.status(400).json({ error: error.message });
  res.json({ data });
});

// ─── POST /api/admin/users — create new user ──────────────────────────────────
router.post('/users', requireAdmin, async (req, res) => {
  let { email, password, full_name, emp_id, role } = req.body;

  if (!email || !password) return res.status(400).json({ error: 'email and password required' });
  if (!password || password.length < 8)
    return res.status(400).json({ error: 'Password must be at least 8 characters' });

  email = email.trim().toLowerCase();

  // FIX: Validate role strictly
  const normRole = (role || '').trim().toLowerCase();
  if (!VALID_ROLES.includes(normRole))
    return res.status(400).json({ error: `Invalid role. Must be one of: ${VALID_ROLES.join(', ')}` });

  if (emp_id) {
    emp_id = emp_id.trim().toUpperCase();
    const { data: empCheck } = await supabase
      .from('employees').select('emp_id, emp_name').eq('emp_id', emp_id).single();
    if (empCheck) {
      emp_id = empCheck.emp_id;
      full_name = full_name || empCheck.emp_name;
    } else if (normRole === 'employee') {
      return res.status(400).json({ error: `Employee ID "${emp_id}" not found in employees table` });
    }
    // For admin/hr: proceed even if not in employees table
  }

  // Check email not already in use
  const { data: existEmail } = await supabase
    .from('user_profiles').select('id').eq('email', email).single();
  if (existEmail) return res.status(409).json({ error: 'A user with this email already exists' });

  // Check emp_id not already linked
  if (emp_id) {
    const { data: existEmp } = await supabase
      .from('user_profiles').select('id').eq('emp_id', emp_id).single();
    if (existEmp) return res.status(409).json({ error: `Employee ID ${emp_id} already has an account` });
  }

  // Create auth user via admin API
  const { data: authData, error: authErr } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name, emp_id: emp_id || null, role: normRole },
  });
  if (authErr) {
    // Log raw error for debugging on Render
    console.error('[admin/users POST] auth.admin.createUser error:', JSON.stringify({
      status: authErr.status,
      message: authErr.message,
      code: authErr.code,
    }));
    const msg = authErr.message || '';
    const friendly = /user not allowed|not allowed|signup.*disabled/i.test(msg)
      ? 'User creation blocked by Supabase. Check that Email Auth is enabled and SUPABASE_SERVICE_ROLE_KEY is correct on Render.'
      : /already registered|already exists/i.test(msg)
      ? 'This email is already registered.'
      : /weak password/i.test(msg)
      ? 'Password too weak. Use at least 8 characters with letters and numbers.'
      : `Supabase error: ${msg}`;
    return res.status(400).json({ error: friendly });
  }

  const { error: profErr } = await supabase.from('user_profiles').upsert({
    id: authData.user.id,
    email,
    full_name: full_name || email,
    emp_id: emp_id || null,
    role: normRole,
    is_active: true,
  });
  if (profErr) {
    await supabase.auth.admin.deleteUser(authData.user.id).catch(() => {});
    return res.status(500).json({ error: 'Profile creation failed: ' + profErr.message });
  }

  if (emp_id) {
    await supabase.from('employees').update({ auth_uid: authData.user.id }).eq('emp_id', emp_id)
      .catch(e => console.warn('[admin/users POST] auth_uid link failed:', e.message));
  }

  res.status(201).json({
    success: true,
    user: { id: authData.user.id, email, role: normRole, emp_id: emp_id || null, full_name },
  });
});

// ─── PATCH /api/admin/users/:userId — update role / emp_id / active status ───
router.patch('/users/:userId', requireAdmin, async (req, res) => {
  const { userId } = req.params;
  const { role, emp_id, is_active, full_name } = req.body;

  // FIX: Validate role if being updated
  if (role !== undefined) {
    const normRole = (role || '').trim().toLowerCase();
    if (!VALID_ROLES.includes(normRole)) {
      return res.status(400).json({ error: `Invalid role. Must be one of: ${VALID_ROLES.join(', ')}` });
    }
  }

  // Prevent admin from deactivating their own account
  if (is_active === false && userId === req.user.id) {
    return res.status(400).json({ error: 'You cannot deactivate your own account' });
  }

  const updates = {};
  if (role !== undefined) updates.role = role.trim().toLowerCase();
  if (emp_id !== undefined) updates.emp_id = emp_id ? emp_id.trim().toUpperCase() : null;
  if (is_active !== undefined) updates.is_active = Boolean(is_active);
  if (full_name) updates.full_name = full_name.trim();
  updates.updated_at = new Date().toISOString();

  if (Object.keys(updates).length === 1) {
    // only updated_at — nothing to actually update
    return res.status(400).json({ error: 'No valid fields provided to update' });
  }

  const { error } = await supabase.from('user_profiles').update(updates).eq('id', userId);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true });
});

// ─── DELETE /api/admin/users/:userId ─────────────────────────────────────────
router.delete('/users/:userId', requireAdmin, async (req, res) => {
  const { userId } = req.params;

  // Prevent self-deletion
  if (userId === req.user.id) {
    return res.status(400).json({ error: 'You cannot delete your own account' });
  }

  const { error } = await supabase.auth.admin.deleteUser(userId);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true });
});

// ─── POST /api/admin/users/:userId/reset-password ────────────────────────────
router.post('/users/:userId/reset-password', requireAdmin, async (req, res) => {
  const { userId } = req.params;
  const { password } = req.body;
  if (!password || password.length < 8)
    return res.status(400).json({ error: 'Password must be at least 8 characters' });

  const { error } = await supabase.auth.admin.updateUserById(userId, { password });
  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true });
});

// ─── GET /api/admin/enrollments — list all enrollments ───────────────────────
router.get('/enrollments', async (req, res) => {
  const { status } = req.query;

  // FIX: Validate status value to prevent injection
  const VALID_STATUSES = ['ALL', 'DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED'];
  if (status && !VALID_STATUSES.includes(status)) {
    return res.status(400).json({ error: `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}` });
  }

  let query = supabase.from('employee_gmc_enrollment')
    .select(`enrollment_id,emp_id,emp_name,department,designation,date_of_joining,
             selected_sum_insured,enrollment_status,submitted_at,reviewed_at,reviewed_by,
             admin_remarks,locked_at,terms_accepted,final_declaration_accepted`)
    .order('submitted_at', { ascending: false, nullsFirst: false });

  if (status && status !== 'ALL') query = query.eq('enrollment_status', status);

  const { data, error } = await query;
  if (error) return res.status(400).json({ error: error.message });

  // Attach summaries + live CTC GMC totals from view
  const enrollmentIds = (data || []).map(e => e.enrollment_id).filter(Boolean);
  const empIds        = (data || []).map(e => e.emp_id).filter(Boolean);

  const [{ data: summaries }, { data: liveTotals }] = await Promise.all([
    enrollmentIds.length
      ? supabase.from('employee_gmc_enrollment_summary')
          .select('enrollment_id,total_insurer_premium,total_ctc_gmc_available,salary_deduction,gmc_refund')
          .in('enrollment_id', enrollmentIds)
      : { data: [] },
    empIds.length
      ? supabase.from('vw_employee_ctc_gmc_total')
          .select('emp_id,total_ctc_gmc')
          .in('emp_id', empIds)
      : { data: [] },
  ]);

  const summaryMap   = {};
  (summaries  || []).forEach(s => { summaryMap[s.enrollment_id] = s; });
  const liveTotalMap = {};
  (liveTotals || []).forEach(r => { liveTotalMap[r.emp_id] = Number(r.total_ctc_gmc); });

  res.json({
    data: (data || []).map(e => {
      const saved   = summaryMap[e.enrollment_id] || null;
      const liveCtc = liveTotalMap[e.emp_id] ?? null;
      if (!saved) return { ...e, summary: null };
      // Recalculate deduction/refund using live ctc when available
      const ctc      = liveCtc ?? Number(saved.total_ctc_gmc_available || 0);
      const premium  = Number(saved.total_insurer_premium || 0);
      return {
        ...e,
        summary: {
          ...saved,
          total_ctc_gmc_available: liveCtc ?? saved.total_ctc_gmc_available,
          salary_deduction: Math.max(0, premium - ctc),
          gmc_refund:       Math.max(0, ctc - premium),
        },
      };
    }),
  });
});

// ─── GET /api/admin/enrollments/:id — full enrollment detail ─────────────────
router.get('/enrollments/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid enrollment ID' });

  const [enrollRes, membersRes, summaryRes, auditRes] = await Promise.all([
    supabase.from('employee_gmc_enrollment').select('*').eq('enrollment_id', id).single(),
    supabase.from('employee_gmc_enrollment_insured').select('*').eq('enrollment_id', id),
    supabase.from('employee_gmc_enrollment_summary').select('*').eq('enrollment_id', id).single(),
    supabase.from('employee_gmc_enrollment_audit').select('*').eq('enrollment_id', id).order('created_at'),
  ]);

  if (!enrollRes.data) return res.status(404).json({ error: 'Enrollment not found' });

  const empId = enrollRes.data.emp_id;

  // ── Always fetch live CTC GMC total from view — this is the authoritative value.
  // The saved summary.total_ctc_gmc_available may be stale (calculated at submission
  // time using DOJ fallback before gmc_effective_date was populated).
  const { data: ctcTotalRow } = await supabase
    .from('vw_employee_ctc_gmc_total')
    .select('total_ctc_gmc')
    .eq('emp_id', empId)
    .single();
  const liveTotalCtcGmc = ctcTotalRow?.total_ctc_gmc ?? null;

  // ── Merge: override saved summary's ctc field with live view value.
  // If the live view has a value, it always wins over the stale saved summary.
  const savedSummary = summaryRes.data || null;
  const mergedSummary = savedSummary ? {
    ...savedSummary,
    // Override stale ctc with live view value
    total_ctc_gmc_available: liveTotalCtcGmc ?? savedSummary.total_ctc_gmc_available,
    // Recalculate deduction/refund against live ctc
    ...(liveTotalCtcGmc != null ? (() => {
      const premium  = Number(savedSummary.total_insurer_premium || 0);
      const ctc      = Number(liveTotalCtcGmc);
      return {
        salary_deduction: Math.max(0, premium - ctc),
        gmc_refund:       Math.max(0, ctc - premium),
      };
    })() : {}),
    _ctc_source: liveTotalCtcGmc != null ? 'live_view' : 'saved_summary',
  } : (liveTotalCtcGmc != null ? {
    // No saved summary at all but view has a value — build minimal summary
    total_ctc_gmc_available: liveTotalCtcGmc,
    _ctc_source: 'live_view',
  } : null);

  res.json({
    enrollment: enrollRes.data,
    insured_members: membersRes.data || [],
    summary: mergedSummary,
    audit: auditRes.data || [],
    live_ctc_gmc_total: liveTotalCtcGmc,  // exposed separately for transparency
  });
});

// ─── PATCH /api/admin/enrollments/:id — approve / reject / correction ─────────
router.patch('/enrollments/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid enrollment ID' });

  const { action, admin_remarks } = req.body;
  if (!['APPROVED', 'REJECTED', 'CORRECTION_REQUIRED'].includes(action))
    return res.status(400).json({ error: 'Invalid action. Must be APPROVED, REJECTED, or CORRECTION_REQUIRED' });

  // ── 25s server-side timeout guard ─────────────────────────────────────────
  // Prevents Render.com from sending an HTML 502 when Supabase is slow.
  let responded = false;
  const timeoutId = setTimeout(() => {
    if (!responded) {
      responded = true;
      res.status(503).json({ error: 'Action timed out. Please refresh — your action may have saved. If status unchanged, try again.' });
    }
  }, 25000);

  const send = (status, body) => {
    if (responded) return;
    responded = true;
    clearTimeout(timeoutId);
    res.status(status).json(body);
  };

  try {
    const reviewerName = req.user?.full_name || req.user?.emp_id || 'Admin';
    const now = new Date().toISOString();

    const updates = {
      enrollment_status: action === 'CORRECTION_REQUIRED' ? 'DRAFT' : action,
      admin_remarks: admin_remarks?.trim() || null,
      reviewed_by: reviewerName,
      reviewed_at: now,
      updated_at: now,
      ...(action === 'APPROVED' ? { locked_at: now, locked_by: reviewerName } : {}),
    };

    const { error } = await supabase.from('employee_gmc_enrollment').update(updates).eq('enrollment_id', id);
    if (error) return send(400, { error: error.message });

    const { data: enroll } = await supabase
      .from('employee_gmc_enrollment').select('emp_id').eq('enrollment_id', id).single();

    // Audit log (non-fatal)
    await supabase.from('employee_gmc_enrollment_audit').insert({
      enrollment_id: id,
      emp_id: enroll?.emp_id,
      action,
      action_by: reviewerName,
      remarks: admin_remarks?.trim() || null,
      created_at: now,
    }).catch(e => console.warn('[admin/enrollments PATCH] audit failed:', e.message));

    // Fire confirmation email if approved (non-blocking)
    if (action === 'APPROVED' && process.env.SUPABASE_URL) {
      fetch(`${process.env.SUPABASE_URL}/functions/v1/enrollment-confirmation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` },
        body: JSON.stringify({ enrollment_id: id, secret: process.env.FUNCTION_SECRET || '' }),
      }).catch(e => console.warn('[admin/enrollments PATCH] email failed:', e.message));
    }

    send(200, { success: true, action });
  } catch (err) {
    console.error('[admin/enrollments PATCH] error:', err.message);
    send(500, { error: 'Action failed: ' + err.message });
  }
});

export default router;
