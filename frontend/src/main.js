import * as XLSX from 'xlsx';
import { jsPDF } from 'jspdf';
import 'jspdf-autotable';
import './style.css';
// ✅ All data goes through our Express backend. Zero direct Supabase calls here.
import { auth, tables, views, admin, apiFetch, enrollment, adminEnrollment, tokenStore, renewal } from './lib/api.js';

// ─── STATE ─────────────────────────────────────────────────────────────────────
let state = {
  user: null, role: 'employee', empId: '', userName: '',
  currentPage: 'dashboard', currentTable: null,
  tableData: [], exportData: null,
  page: 0, pageSize: 25, empFilter: '', search: '',
  editingRow: null, currentView: null, totalCount: 0,
  searchAllRows: null,   // ✅ holds the FULL dataset while a global search is active
};
let _searchDebounce = null;

// ─── TABLE DEFINITIONS ─────────────────────────────────────────────────────────
const TABLES = {
  t_employees: {
    name: 'employees', label: 'Employees', key: 'id',
    columns: ['id','emp_id','emp_name','gender','department','designation','date_of_joining','date_of_birth','ctc','ctc_gmc_per_month','unit','status','is_active','email_id','mobile_number','gmc_inclusion_date','gmc_effective_date','exit_date','exit_type','last_working_day','claimed_this_year','remarks'],
    insertable: true,
  },
  t_blood_group: {
    name: 'employee_blood_group', label: 'Blood Groups', key: 'emp_id',
    columns: ['emp_id','blood_group','created_at','updated_at'],
    insertable: true,
  },
  t_dependents: {
    name: 'dependents', label: 'Dependents', key: 'id',
    columns: ['id','employee_id','dependent_name','relationship','date_of_birth','gender'],
    insertable: true,
  },
  t_insurance_dependents: {
    name: 'insurance_dependents', label: 'Insurance Dependents', key: 'id',
    columns: ['id','emp_id','insured_name','relationship','gender','date_of_birth','sum_insured','policy_start_date','policy_end_date','status','hr_employee_active','uhid'],
    insertable: true,
  },
  t_gmc_enrollment: {
    name: 'employee_gmc_enrollment', label: 'GMC Enrollment', key: 'enrollment_id',
    columns: ['enrollment_id','emp_id','emp_name','gender','department','designation','date_of_joining','date_of_birth','mobile_number','email_id','ctc_approx','ctc_gmc_per_month','gmc_inclusion_date','gmc_effective_date','selected_sum_insured','is_gmc_eligible','enrollment_status','submitted_at','admin_remarks','reviewed_by','reviewed_at'],
    insertable: true,
  },
  t_gmc_claims: {
    name: 'employee_gmc_claims', label: 'GMC Claims', key: 'id',
    columns: ['id','claim_id','insurer_claim_ref_no','policy_no','benef_name','benef_relation','benef_age','benef_gender','benef_sum_insured','intimation_date','date_of_admission','date_of_discharge','hospital_name','hospital_city','hospital_state','claim_type','claim_stage','claim_status','claim_amount','claim_approved_amount','incurred_amount','primary_icd_group','primary_ailment_name','treatment_type','tpa_name','settled_date'],
    insertable: true,
  },
  t_ctc_increment: {
    name: 'employee_ctc_gmc_increment', label: 'CTC GMC Increment', key: 'id',
    columns: ['id','emp_id','new_ctc_gmc_per_month','increment_effective_date','uploaded_at'],
    insertable: true,
  },
  t_actual_deduction: {
    name: 'employee_gmc_actual_deduction', label: 'GMC Actual Deduction', key: 'id',
    columns: ['id','emp_id','payroll_month','deducted_amount','remarks','uploaded_at'],
    insertable: true,
  },
  t_health_checkups: {
    name: 'employee_health_checkups', label: 'Health Checkups', key: 'id',
    columns: ['id','emp_id','health_checkup_date','health_checkup_type','vendor_details','remarks'],
    insertable: true,
  },
  t_typhoid_vaccination: {
    name: 'employee_typhoid_vaccination', label: 'Typhoid Vaccination', key: 'vaccination_id',
    columns: ['vaccination_id','emp_id','vaccination_date','remarks'],
    insertable: true,
  },
  t_insurance_cd_payments: {
    name: 'insurance_cd_payments', label: 'CD Payments', key: 'payment_id',
    columns: ['payment_id','insurer_name','payment_date','paid_amount','payment_mode','reference_no','remarks'],
    insertable: true,
  },
  t_policy_premium: {
    name: 'policy_premium_details', label: 'Policy Premium Details', key: 'deduction_id',
    columns: ['deduction_id','insurance_type','insurer_name','policy_number','endorsement_date','endorsement_no','endorsement_details','premium_inclusive_gst','invoice_number','remarks'],
    insertable: true,
  },
  t_gmc_rate_cards: {
    name: 'gmc_rate_cards', label: 'GMC Rate Cards', key: 'rate_card_id',
    columns: ['rate_card_id','rate_card_type','age_band_from','age_band_to','sum_insured','annual_premium'],
    insertable: true,
  },
  t_opening_balance: {
    name: 'insurer_opening_balance', label: 'Insurer Opening Balance', key: 'insurer_name',
    columns: ['insurer_name','opening_balance','opening_balance_date'],
    insertable: true,
  },
  t_gmc_exit: {
    name: 'employee_gmc_exit', label: 'GMC Exit', key: 'emp_id',
    columns: ['emp_id','exit_date','last_working_day','exit_type'],
    insertable: true,
  },
  t_gmc_financials: {
    name: 'employee_gmc_financials_25_26', label: 'GMC Financials 25-26', key: 'emp_id',
    columns: ['emp_id','total_premium','total_ctc_gmc','opening_balance','net_employee_position','employee_deduction','ctc_gmc_refund','calculation_date','locked'],
    insertable: false,
  },
  t_gmc_net_balance: {
    name: 'employee_gmc_net_balance', label: 'GMC Net Balance', key: 'emp_id',
    columns: ['emp_id','opening_balance','current_policy_balance','net_balance'],
    insertable: false,
  },
  t_gmc_opening_balance: {
    name: 'employee_gmc_opening_balance', label: 'Employee GMC Opening Balance', key: 'emp_id',
    columns: ['emp_id','opening_balance','remarks'],
    insertable: true,
  },
  t_enrollment_manual: {
    name: 'insurance_enrollment_manual', label: 'Manual Enrollment', key: 'id',
    columns: ['id','emp_id','insured_name','relationship','gender','date_of_birth','sum_insured'],
    insertable: true,
  },
  t_concerns: {
    name: 'user_concerns', label: 'Correction Concerns', key: 'id',
    columns: ['id','emp_id','table_name','description','status','admin_response','created_at'],
    insertable: true,
  },
};

const VIEWS = [
  { key: 'vw_active_employees_missing_gpa',         label: 'Active Employees Missing GPA',    empFilter: true },
  { key: 'vw_ctc_gmc_slab_timeline',               label: 'CTC GMC Slab Timeline',           empFilter: true },
  { key: 'vw_employee_blood_group_status',          label: 'Blood Group Status',              empFilter: true },
  { key: 'vw_employee_ctc_gmc_total',              label: 'CTC GMC Total',                   empFilter: true },
  { key: 'vw_employee_dependent_premium',          label: 'Dependent Premium',               empFilter: true },
  { key: 'vw_employee_gmc_net_recoverable',        label: 'GMC Net Recoverable',             empFilter: true },
  { key: 'vw_employee_premium_total',              label: 'Employee Premium Total',          empFilter: true },
  { key: 'vw_employee_with_claim_status',          label: 'Employee Claim Status',           empFilter: true },
  { key: 'vw_ff_base_employees',                  label: 'FF Base Employees',               empFilter: true },
  { key: 'vw_ff_ctc_gmc_total',                   label: 'FF CTC GMC Total',                empFilter: true },
  { key: 'vw_ff_emi_recovered',                   label: 'FF EMI Recovered',                empFilter: true },
  { key: 'vw_ff_insurance_days',                  label: 'FF Insurance Days',               empFilter: true },
  { key: 'vw_gmc_claim_financial_summary',         label: 'GMC Claim Financial Summary',     empFilter: false },
  { key: 'vw_gmc_claim_hospital_analysis',         label: 'GMC Hospital Analysis',           empFilter: false },
  { key: 'vw_gmc_claim_summary_agewise',          label: 'GMC Claims Age-wise',             empFilter: false },
  { key: 'vw_gmc_claim_summary_disease_group',    label: 'GMC Claims by Disease',           empFilter: false },
  { key: 'vw_gmc_claim_summary_relationship',     label: 'GMC Claims by Relationship',      empFilter: false },
  { key: 'vw_gmc_emi_control',                    label: 'GMC EMI Control',                 empFilter: true },
  { key: 'vw_gmc_emi_ledger',                     label: 'GMC EMI Ledger',                  empFilter: true },
  { key: 'vw_gmc_policy_constants',               label: 'GMC Policy Constants',            empFilter: false },
  { key: 'vw_gmc_settlement',                     label: 'GMC Settlement',                  empFilter: true },
  { key: 'vw_gmc_statement_required',             label: 'GMC Statement Required',          empFilter: true },
  { key: 'vw_gpa_addition',                       label: 'GPA Addition',                    empFilter: true },
  { key: 'vw_gpa_deletion',                       label: 'GPA Deletion',                    empFilter: true },
  { key: 'vw_insurance_addition_deletion_premium',label: 'Addition/Deletion Premium',       empFilter: false },
  { key: 'vw_insurance_coverage_days',            label: 'Coverage Days',                   empFilter: true },
  { key: 'vw_insurance_dependents_control',       label: 'Dependents Control',              empFilter: true },
  { key: 'vw_insurance_dependents_eligibility_status', label: 'Dependents Eligibility',     empFilter: true },
  { key: 'vw_magma_insurance_addition_requests',  label: 'Magma Addition Requests',         empFilter: false },
  { key: 'vw_magma_insurance_deletion_requests',  label: 'Magma Deletion Requests',         empFilter: false },
  { key: 'vw_total_premium_exit_employee',        label: 'Total Premium Exit Employee',     empFilter: true },
];

const VIEW_META = {
  vw_active_employees_missing_gpa:         { filterCol: 'emp_id', icon: '⚠️',  category: 'Employee' },
  vw_ctc_gmc_slab_timeline:               { filterCol: 'emp_id', icon: '📈',  category: 'Finance' },
  vw_employee_blood_group_status:         { filterCol: 'emp_id', icon: '🩸',  category: 'Employee' },
  vw_employee_ctc_gmc_total:              { filterCol: 'emp_id', icon: '💰',  category: 'Finance' },
  vw_employee_dependent_premium:          { filterCol: 'emp_id', icon: '👨‍👩‍👧', category: 'GMC' },
  vw_employee_gmc_net_recoverable:        { filterCol: 'emp_id', icon: '⚖️',  category: 'Finance' },
  vw_employee_premium_total:              { filterCol: 'emp_id', icon: '💳',  category: 'Finance' },
  vw_employee_with_claim_status:          { filterCol: 'emp_id', icon: '🏥',  category: 'Claims' },
  vw_ff_base_employees:                  { filterCol: 'emp_id', icon: '👤',  category: 'F&F' },
  vw_ff_ctc_gmc_total:                   { filterCol: 'emp_id', icon: '💹',  category: 'F&F' },
  vw_ff_emi_recovered:                   { filterCol: 'emp_id', icon: '📥',  category: 'F&F' },
  vw_ff_insurance_days:                  { filterCol: 'emp_id', icon: '📅',  category: 'F&F' },
  vw_gmc_claim_financial_summary:         { filterCol: null,     icon: '📊',  category: 'Claims' },
  vw_gmc_claim_hospital_analysis:         { filterCol: null,     icon: '🏨',  category: 'Claims' },
  vw_gmc_claim_summary_agewise:          { filterCol: null,     icon: '📋',  category: 'Claims' },
  vw_gmc_claim_summary_disease_group:    { filterCol: null,     icon: '🦠',  category: 'Claims' },
  vw_gmc_claim_summary_relationship:     { filterCol: null,     icon: '👨‍👩‍👦', category: 'Claims' },
  vw_gmc_emi_control:                    { filterCol: 'emp_id', icon: '🎛️',  category: 'Finance' },
  vw_gmc_emi_ledger:                     { filterCol: 'emp_id', icon: '📒',  category: 'Finance' },
  vw_gmc_policy_constants:               { filterCol: null,     icon: '📌',  category: 'Policy' },
  vw_gmc_settlement:                     { filterCol: 'emp_id', icon: '🤝',  category: 'F&F' },
  vw_gmc_statement_required:             { filterCol: 'emp_id', icon: '📝',  category: 'F&F' },
  vw_gpa_addition:                       { filterCol: 'emp_id', icon: '➕',  category: 'GPA' },
  vw_gpa_deletion:                       { filterCol: 'emp_id', icon: '➖',  category: 'GPA' },
  vw_insurance_addition_deletion_premium:{ filterCol: null,     icon: '💱',  category: 'Policy' },
  vw_insurance_coverage_days:            { filterCol: 'emp_id', icon: '📆',  category: 'GMC' },
  vw_insurance_dependents_control:       { filterCol: 'emp_id', icon: '🔗',  category: 'GMC' },
  vw_insurance_dependents_eligibility_status: { filterCol: 'emp_id', icon: '✅', category: 'GMC' },
  vw_magma_insurance_addition_requests:  { filterCol: null,     icon: '📤',  category: 'Policy' },
  vw_magma_insurance_deletion_requests:  { filterCol: null,     icon: '📤',  category: 'Policy' },
  vw_total_premium_exit_employee:        { filterCol: 'emp_id', icon: '🚪',  category: 'F&F' },
};

const VIEW_CATEGORIES = ['All','Employee','GMC','Finance','F&F','Claims','GPA','Policy'];

// ─── AUTH ──────────────────────────────────────────────────────────────────────
// Role is auto-detected from DB on login — no tab selection required.

// ─── CLOUDFLARE TURNSTILE ─────────────────────────────────────────────────────
const TURNSTILE_SITE_KEY = '0x4AAAAAACkZLaHpH_V7JE3L';
let turnstileLoginWidgetId  = null;
let turnstileSignupWidgetId = null;
let turnstileLoginToken     = '';
let turnstileSignupToken    = '';

function initTurnstile() {
  if (typeof window.turnstile === 'undefined') {
    window.onloadTurnstileCallback = initTurnstile;
    return;
  }
  
  // ✅ FIX: Check if element exists before rendering
  if (!turnstileLoginWidgetId && document.getElementById('turnstile-login')) {
    try {
      turnstileLoginWidgetId = window.turnstile.render('#turnstile-login', {
        sitekey:  TURNSTILE_SITE_KEY,
        theme:    'light',
        callback:          (token) => { turnstileLoginToken  = token; },
        'expired-callback': ()     => { turnstileLoginToken  = ''; },
        'error-callback':   ()     => { turnstileLoginToken  = ''; },
      });
    } catch (e) {
      console.warn('[Turnstile] Login container missing or error:', e.message);
    }
  }
  
  // ✅ FIX: Check if element exists before rendering
  if (!turnstileSignupWidgetId && document.getElementById('turnstile-signup')) {
    try {
      turnstileSignupWidgetId = window.turnstile.render('#turnstile-signup', {
        sitekey:  TURNSTILE_SITE_KEY,
        theme:    'light',
        callback:          (token) => { turnstileSignupToken = token; },
        'expired-callback': ()     => { turnstileSignupToken = ''; },
        'error-callback':   ()     => { turnstileSignupToken = ''; },
      });
    } catch (e) {
      console.warn('[Turnstile] Signup container missing or error:', e.message);
    }
  }
}

function resetTurnstile(which) {
  if (which === 'login'  && turnstileLoginWidgetId  != null) window.turnstile?.reset(turnstileLoginWidgetId);
  if (which === 'signup' && turnstileSignupWidgetId != null) window.turnstile?.reset(turnstileSignupWidgetId);
}

// Init once DOM is ready — Turnstile script is async so use the onload callback
document.addEventListener('DOMContentLoaded', () => {
  if (typeof window.turnstile !== 'undefined') initTurnstile();
  else window.onloadTurnstileCallback = initTurnstile;
});

async function doLogin() {
  const email = document.getElementById('login-email').value.trim();
  const pwd   = document.getElementById('login-password').value;
  const btn   = document.getElementById('login-btn');
  const err   = document.getElementById('login-error');
  err.style.display = 'none';
  btn.disabled = true; btn.textContent = 'Signing in…';

  if (!email || !pwd) {
    err.textContent = 'Please enter your email and password.';
    err.style.display = 'block';
    btn.disabled = false; btn.textContent = 'Sign In';
    return;
  }

  if (!turnstileLoginToken) {
    err.textContent = 'Please wait for the security check to complete.';
    err.style.display = 'block';
    btn.disabled = false; btn.textContent = 'Sign In';
    return;
  }
  const captchaToken = turnstileLoginToken;
  turnstileLoginToken = ''; // consume once — reset widget so it refreshes

  try {
    // 🔒 Single unified login — role is auto-detected from user_profiles in DB.
    const _r = await auth.login(email, pwd, captchaToken);
    // 2FA: backend requests an email OTP when this device isn't trusted yet
    if (_r.otp_required) {
      btn.disabled = false; btn.textContent = 'Sign In';
      showOtpPanel(_r.pending_id, _r.email_masked);
      return;
    }
    const user = _r.user;

    state.user     = user;
    state.role     = user.role || 'employee';
    state.empId    = user.emp_id  || '';
    state.userName = user.full_name || email;

    // First-login: must change default DOB password before accessing portal
    if (user.must_change_password) {
      btn.disabled = false; btn.textContent = 'Sign In';
      showForceChangePanel();
      return;
    }

    // Track login for renewal monitor (employees only, fire-and-forget)
    if (state.role === 'employee' && state.empId) {
      renewal.trackLogin().catch(() => null);
    }

    initApp();
  } catch(e) {
    err.textContent = e.message || 'Login failed. Please check your email and password.';
    err.style.display = 'block';
    resetTurnstile('login');
    btn.disabled = false; btn.textContent = 'Sign In';
  }
}

// ─── OTP (2FA) ────────────────────────────────────────────────────────────────
let _otpPendingId = null;
let _otpResendTimer = null;

function completeLogin(user) {
  state.user     = user;
  state.role     = user.role || 'employee';
  state.empId    = user.emp_id  || '';
  state.userName = user.full_name || (document.getElementById('login-email')?.value?.trim() || '');
  if (user.must_change_password) { showForceChangePanel(); return; }
  if (state.role === 'employee' && state.empId) { renewal.trackLogin().catch(() => null); }
  initApp();
}

function showOtpPanel(pendingId, emailMasked) {
  _otpPendingId = pendingId;
  document.getElementById('login-panel').style.display = 'none';
  document.getElementById('forgot-panel').style.display = 'none';
  document.getElementById('force-change-panel').style.display = 'none';
  const panel = document.getElementById('otp-panel'); if (panel) panel.style.display = '';
  const sub = document.getElementById('otp-sub-email'); if (sub) sub.textContent = emailMasked || 'your registered email';
  const codeEl = document.getElementById('otp-code'); if (codeEl) { codeEl.value = ''; setTimeout(() => codeEl.focus(), 50); }
  const errEl = document.getElementById('otp-error'); if (errEl) errEl.style.display = 'none';
  const remember = document.getElementById('otp-remember'); if (remember) remember.checked = true;
  _startOtpResendCooldown(60);
}

function _startOtpResendCooldown(seconds) {
  const link = document.getElementById('otp-resend-btn');
  const status = document.getElementById('otp-resend-status');
  if (!link) return;
  let left = seconds;
  link.style.display = 'none';
  if (status) { status.style.display = ''; status.textContent = `You can resend in ${left}s`; }
  clearInterval(_otpResendTimer);
  _otpResendTimer = setInterval(() => {
    left -= 1;
    if (left <= 0) { clearInterval(_otpResendTimer); if (status) status.style.display = 'none'; link.style.display = ''; }
    else if (status) { status.textContent = `You can resend in ${left}s`; }
  }, 1000);
}

async function doVerifyOtp() {
  const code = (document.getElementById('otp-code')?.value || '').trim();
  const remember = !!document.getElementById('otp-remember')?.checked;
  const btn = document.getElementById('otp-btn');
  const errEl = document.getElementById('otp-error');
  errEl.style.display = 'none';
  if (!/^\d{6}$/.test(code)) { errEl.textContent = 'Enter the 6-digit code from your email.'; errEl.style.display = 'block'; return; }
  btn.disabled = true; btn.textContent = 'Verifying…';
  try {
    const user = await auth.verifyOtp(_otpPendingId, code, remember);
    clearInterval(_otpResendTimer);
    btn.disabled = false; btn.textContent = 'Verify & Continue →';
    completeLogin(user);
  } catch (e) {
    errEl.textContent = e.message || 'Incorrect or expired code. Please try again.';
    errEl.style.display = 'block';
    btn.disabled = false; btn.textContent = 'Verify & Continue →';
  }
}

async function doResendOtp() {
  const errEl = document.getElementById('otp-error');
  errEl.style.display = 'none';
  try { await auth.resendOtp(_otpPendingId); _startOtpResendCooldown(60); }
  catch (e) { errEl.textContent = e.message || 'Could not resend the code. Please try again.'; errEl.style.display = 'block'; }
}

async function doLogout() {
  await auth.logout();
  state.user = null;
  document.getElementById('login-page').style.display = 'flex';
  document.getElementById('app').classList.remove('visible');
}

// ─── APP INIT ─────────────────────────────────────────────────────────────────
// ⚠️  _origInitApp is superseded by the initApp() override near the bottom of this file.
// It is kept here only as a reference. window.initApp = initApp (the override) is what runs.
function _origInitApp() {
  document.getElementById('login-page').style.display = 'none';
  document.getElementById('app').classList.add('visible');

  const badge = document.getElementById('topbar-badge');
  const roleIcons = { admin: '👑', hr: '👤', employee: '🏷️' };
  badge.className = 'topbar-badge ' + state.role;
  badge.innerHTML = (roleIcons[state.role]||'👤') + ' ' + state.role.toUpperCase();
  document.getElementById('topbar-user').textContent = state.userName || state.user.email;

  if (state.role === 'admin') {
    document.getElementById('admin-section').style.display = 'block';
  }
  if (state.role === 'employee') {
    document.querySelectorAll('.sidebar-item[data-admin-only]').forEach(el => el.style.display = 'none');
    document.querySelectorAll('.sidebar-section-label[data-admin-only]').forEach(el => el.style.display = 'none');
  } else {
    // HR and Admin can see enrollment review; hide employee-only items
    document.querySelectorAll('.sidebar-item[data-employee-only]').forEach(el => el.style.display = 'none');
  }

  navigate(state.role === 'employee' ? 'employee_dashboard' : 'dashboard');
}

// ─── INVITE / SET-PASSWORD FLOW ───────────────────────────────────────────────
// When Supabase redirects from an invite email it appends tokens in the URL hash:
//   https://gcpl.insurance.portal.in/#access_token=xxx&type=invite&refresh_token=yyy
// We detect this BEFORE the normal session restore so the user sees the set-password
// page instead of the login page.

function _parseInviteHash() {
  const hash = window.location.hash;
  if (!hash) return null;
  const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
  const type   = params.get('type');
  if (type !== 'invite' && type !== 'recovery') return null;
  return {
    access_token:  params.get('access_token'),
    refresh_token: params.get('refresh_token'),
    type,
  };
}

let _inviteTokens = null; // held in memory until password is submitted

function showSetPasswordPage(tokens, email = '') {
  _inviteTokens = tokens;
  // Clean the hash from the URL so tokens aren't visible / re-triggered on refresh
  history.replaceState(null, '', window.location.pathname + window.location.search);
  document.getElementById('set-password-page').style.display = 'flex';
  document.getElementById('login-page').style.display        = 'none';
  document.getElementById('app').style.display               = 'none';
  if (email) document.getElementById('set-pwd-sub').textContent =
    `Welcome! Set a password for ${email}`;
}

function showLoginPage() {
  document.getElementById('set-password-page').style.display = 'none';
  document.getElementById('login-page').style.display        = 'flex';
}

async function doSetPassword() {
  const pwd    = document.getElementById('set-pwd-input').value;
  const pwd2   = document.getElementById('set-pwd-confirm').value;
  const errEl  = document.getElementById('set-pwd-error');
  const btn    = document.getElementById('set-pwd-btn');

  errEl.style.display = 'none';

  if (!pwd)              { errEl.textContent = 'Please enter a password.';                         errEl.style.display = 'block'; return; }
  if (pwd.length < 8)    { errEl.textContent = 'Password must be at least 8 characters.';          errEl.style.display = 'block'; return; }
  if (!/\d/.test(pwd))   { errEl.textContent = 'Password must contain at least one number.';       errEl.style.display = 'block'; return; }
  if (pwd !== pwd2)      { errEl.textContent = 'Passwords do not match.';                          errEl.style.display = 'block'; return; }
  if (!_inviteTokens)    { errEl.textContent = 'Invite session lost. Please use the invite link again.'; errEl.style.display = 'block'; return; }

  btn.disabled     = true;
  btn.textContent  = 'Activating…';

  try {
    const user = await auth.setPassword(
      _inviteTokens.access_token,
      _inviteTokens.refresh_token,
      pwd
    );
    _inviteTokens = null;
    // Log user straight in
    state.user     = user;
    state.role     = user.role;
    state.empId    = user.emp_id  || '';
    state.userName = user.full_name || user.email;
    document.getElementById('set-password-page').style.display = 'none';
    initApp();
  } catch (e) {
    errEl.textContent = e.message || 'Failed to set password. Please try again.';
    errEl.style.display = 'block';
    btn.disabled    = false;
    btn.textContent = 'Activate Account →';
  }
}

window.doSetPassword = doSetPassword;
window.showLoginPage  = showLoginPage;

// Restore session on page load
(async () => {
  // ── Check for invite / password-reset link first ──
  const inviteData = _parseInviteHash();
  if (inviteData?.access_token) {
    // Peek at the token to show the user's email in the heading
    let email = '';
    try {
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/auth/v1/user`, {
        headers: { Authorization: `Bearer ${inviteData.access_token}`, apikey: import.meta.env.VITE_SUPABASE_ANON_KEY }
      });
      const u = await res.json();
      email = u?.email || '';
    } catch { /* silently ignore — email hint is cosmetic */ }
    showSetPasswordPage(inviteData, email);
    return; // stop — don't attempt normal session restore
  }

  // ── Normal session restore ──
  if (auth.isLoggedIn()) {
    try {
      // Validate token with server
      const user = await auth.validate();
      if (user) {
        state.user     = user;
        state.role     = user.role;
        state.empId    = user.emp_id  || '';
        state.userName = user.full_name || user.email;
        initApp();
      }
    } catch(e) {
      // Token invalid — show login
      auth.logout();
    }
  }
})();

// ─── NAVIGATION ───────────────────────────────────────────────────────────────
function _origNavigate(page) {
  state.currentPage = page;
  state.page = 0; state.search = ''; state.empFilter = ''; state.searchAllRows = null;

  document.querySelectorAll('.sidebar-item').forEach(el => {
    el.classList.toggle('active', el.dataset.page === page);
  });

  const titles = {
    dashboard: 'Dashboard', employee_dashboard: 'My Dashboard',
    views: 'Database Views', emp_full_view: 'Employee Full View',
    user_management: 'User Management', concerns: 'Correction Concerns',
    ...Object.fromEntries(Object.entries(TABLES).map(([k,v]) => [k, v.label])),
  };
  document.getElementById('topbar-section').textContent = titles[page] || page;
  renderPage(page);
}

async function renderPage(page) {
  if (page === 'dashboard')          { await renderDashboard(); return; }
  if (page === 'employee_dashboard') { await renderEmployeeDashboard(); return; }
  if (page === 'views')              { renderViewsPage(); return; }
  if (page === 'emp_full_view')      { renderEmpFullView(); return; }
  if (page === 'user_management')    { await renderUserManagement(); return; }
  if (page === 'concerns')           { await renderConcernsPage(); return; }
  if (page === 'gmc_enrollment_form'){ await renderEnrollmentForm(); return; }
  if (page === 'admin_enrollments')  { await renderAdminEnrollments(); return; }
  if (TABLES[page])                  { await renderTable(page); return; }
}

// ─── ADMIN DASHBOARD ──────────────────────────────────────────────────────────
async function renderDashboard() {
  const c = document.getElementById('content');
  c.innerHTML = '<div class="loading"><div class="spinner"></div> Loading stats…</div>';

  // Count queries via backend — no Supabase in browser
  const [empRes, claimRes, depRes, enrollRes] = await Promise.all([
    tables.list('employees',               { pageSize: 1, page: 0 }),
    tables.list('employee_gmc_claims',     { pageSize: 1, page: 0 }),
    tables.list('insurance_dependents',    { pageSize: 1, page: 0 }),
    tables.list('employee_gmc_enrollment', { pageSize: 1, page: 0 }),
  ]).catch(() => [null,null,null,null]);

  c.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">Dashboard</div>
        <div class="page-sub">Insurance Portal Overview · insurance-portal.in</div>
      </div>
    </div>
    <div class="stats-grid">
      <div class="stat-card blue">
        <div class="stat-icon">👥</div>
        <div class="stat-label">Total Employees</div>
        <div class="stat-value">${(empRes?.count||0).toLocaleString()}</div>
        <div class="stat-sub">Across all departments</div>
      </div>
      <div class="stat-card green">
        <div class="stat-icon">🏥</div>
        <div class="stat-label">GMC Claims</div>
        <div class="stat-value">${(claimRes?.count||0).toLocaleString()}</div>
        <div class="stat-sub">Total filed</div>
      </div>
      <div class="stat-card purple">
        <div class="stat-icon">👨‍👩‍👧</div>
        <div class="stat-label">Insured Dependents</div>
        <div class="stat-value">${(depRes?.count||0).toLocaleString()}</div>
        <div class="stat-sub">Across all employees</div>
      </div>
      <div class="stat-card amber">
        <div class="stat-icon">📋</div>
        <div class="stat-label">GMC Enrollments</div>
        <div class="stat-value">${(enrollRes?.count||0).toLocaleString()}</div>
        <div class="stat-sub">Total enrollments</div>
      </div>
    </div>

    <div class="page-header" style="margin-top:8px">
      <div><div class="page-title" style="font-size:17px">Quick Navigation</div></div>
    </div>
    <div class="views-grid">
      ${[['t_employees','👥'],['t_gmc_enrollment','📋'],['t_gmc_claims','🏥'],['t_insurance_dependents','🔗'],['t_actual_deduction','💳'],['t_gmc_financials','📊']].map(([k,icon])=> TABLES[k] ? `
        <div class="view-card" onclick="navigate('${k}')">
          <div class="view-card-title">${icon} ${TABLES[k].label}</div>
          <div class="view-card-sub">Table · ${TABLES[k].columns.length} columns</div>
        </div>` : '').join('')}
      <div class="view-card" onclick="navigate('views')">
        <div class="view-card-title">📊 All Views</div>
        <div class="view-card-sub">${VIEWS.length} views · Emp_ID filter</div>
      </div>
      <div class="view-card" onclick="navigate('concerns')">
        <div class="view-card-title">📝 Correction Concerns</div>
        <div class="view-card-sub">Employee data correction requests</div>
      </div>
    </div>
  `;
}

// ─── EMPLOYEE DASHBOARD ───────────────────────────────────────────────────────
async function _origRenderEmployeeDashboard() {
  const c = document.getElementById('content');
  const empId = state.empId;
  c.innerHTML = `<div class="loading"><div class="spinner"></div> Loading your data…</div>`;

  if (!empId) {
    c.innerHTML = `<div class="empty-state"><div class="icon">⚠️</div><b>Emp ID not linked.</b><br>Contact your Admin to link your Employee ID to your account.</div>`;
    return;
  }

  // 🔒 One call — backend fetches all tables/views and enforces ownership
  let result;
  try { result = await views.employeeFull(empId); }
  catch(e) { c.innerHTML = `<div class="empty-state"><div class="icon">⚠️</div>${e.message}</div>`; return; }

  const data   = result?.data || {};
  const emp    = data.employees?.[0];
  const deps   = data.insurance_dependents || [];
  const enroll = data.employee_gmc_enrollment?.[0];
  const claims = data.employee_gmc_claims || [];
  const health = data.employee_health_checkups || [];
  const vax    = data.employee_typhoid_vaccination || [];

  c.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">Welcome, ${emp?.emp_name || 'Employee'}</div>
        <div class="page-sub">Emp ID: <code>${empId}</code> · ${emp?.department||''} · ${emp?.designation||''}</div>
      </div>
      <span class="badge ${emp?.is_active ? 'badge-green':'badge-red'}">${emp?.status || (emp?.is_active?'Active':'Inactive')}</span>
    </div>

    <div class="stats-grid">
      <div class="stat-card blue">
        <div class="stat-icon">🏥</div>
        <div class="stat-label">Sum Insured</div>
        <div class="stat-value" style="font-size:20px">₹${enroll?.selected_sum_insured ? Number(enroll.selected_sum_insured).toLocaleString('en-IN') : '—'}</div>
        <div class="stat-sub">GMC Coverage</div>
      </div>
      <div class="stat-card green">
        <div class="stat-icon">👨‍👩‍👧</div>
        <div class="stat-label">Insured Members</div>
        <div class="stat-value">${deps.length + 1}</div>
        <div class="stat-sub">Self + ${deps.length} dependent(s)</div>
      </div>
      <div class="stat-card purple">
        <div class="stat-icon">📋</div>
        <div class="stat-label">Enrollment Status</div>
        <div class="stat-value" style="font-size:16px">${enroll?.enrollment_status || 'N/A'}</div>
        <div class="stat-sub">${enroll ? 'Enrolled' : 'Not enrolled'}</div>
      </div>
      <div class="stat-card amber">
        <div class="stat-icon">🏨</div>
        <div class="stat-label">Total Claims</div>
        <div class="stat-value">${claims.length}</div>
        <div class="stat-sub">Filed this year</div>
      </div>
    </div>

    <div class="info-panel" style="margin-bottom:20px">
      <div class="info-panel-title">📝 Have a correction request?</div>
      <div class="info-panel-sub">If any of your data below looks incorrect, go to <b>Correction Concerns</b> in the sidebar to raise a request to HR.</div>
    </div>

    <!-- Dependents -->
    <div style="margin-bottom:24px">
      <div style="font-size:15px;font-weight:700;margin-bottom:12px;color:#0f172a">👨‍👩‍👧 Your Insured Dependents</div>
      ${deps.length === 0 ? '<div class="empty-state" style="padding:20px"><div class="icon">📭</div>No dependents on record</div>' : `
      <div class="table-wrap"><table class="data-table">
        <thead><tr><th>Name</th><th>Relationship</th><th>Date of Birth</th><th>Sum Insured</th><th>Policy Start</th><th>Policy End</th><th>Status</th></tr></thead>
        <tbody>
          ${deps.map(d=>`<tr>
            <td>${d.insured_name||'—'}</td><td>${d.relationship||'—'}</td><td>${d.date_of_birth||'—'}</td>
            <td>${d.sum_insured ? '₹'+Number(d.sum_insured).toLocaleString('en-IN') : '—'}</td>
            <td>${d.policy_start_date||'—'}</td><td>${d.policy_end_date||'—'}</td>
            <td><span class="badge ${d.status==='A'?'badge-green':'badge-red'}">${d.status==='A'?'Active':'Inactive'}</span></td>
          </tr>`).join('')}
        </tbody>
      </table></div>`}
    </div>

    <!-- Claims -->
    <div style="margin-bottom:24px">
      <div style="font-size:15px;font-weight:700;margin-bottom:12px;color:#0f172a">🏥 Your GMC Claims</div>
      ${claims.length === 0 ? '<div class="empty-state" style="padding:20px"><div class="icon">📭</div>No claims on record</div>' : `
      <div class="table-wrap"><table class="data-table">
        <thead><tr><th>Claim ID</th><th>Beneficiary</th><th>Hospital</th><th>Admission</th><th>Claim Amt</th><th>Approved</th><th>Stage</th><th>Status</th></tr></thead>
        <tbody>
          ${claims.map(cl=>`<tr>
            <td><code>${cl.claim_id||'—'}</code></td><td>${cl.benef_name||'—'}</td><td>${cl.hospital_name||'—'}</td>
            <td>${cl.date_of_admission||'—'}</td>
            <td>${cl.claim_amount ? '₹'+Number(cl.claim_amount).toLocaleString('en-IN') : '—'}</td>
            <td>${cl.claim_approved_amount ? '₹'+Number(cl.claim_approved_amount).toLocaleString('en-IN') : '—'}</td>
            <td><span class="badge badge-blue">${cl.claim_stage||'—'}</span></td>
            <td><span class="badge badge-amber">${cl.claim_status||'—'}</span></td>
          </tr>`).join('')}
        </tbody>
      </table></div>`}
    </div>

    <!-- Health + Vaccination -->
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:20px">
      <div>
        <div style="font-size:15px;font-weight:700;margin-bottom:12px;color:#0f172a">🩺 Health Checkups</div>
        ${health.length === 0 ? '<div class="empty-state" style="padding:20px"><div class="icon">📭</div>No records</div>' : `
        <div class="table-wrap"><table class="data-table">
          <thead><tr><th>Date</th><th>Type</th><th>Vendor</th></tr></thead>
          <tbody>${health.map(h=>`<tr><td>${h.health_checkup_date||'—'}</td><td>${h.health_checkup_type||'—'}</td><td>${h.vendor_details||'—'}</td></tr>`).join('')}</tbody>
        </table></div>`}
      </div>
      <div>
        <div style="font-size:15px;font-weight:700;margin-bottom:12px;color:#0f172a">💉 Typhoid Vaccination</div>
        ${vax.length === 0 ? '<div class="empty-state" style="padding:20px"><div class="icon">📭</div>No records</div>' : `
        <div class="table-wrap"><table class="data-table">
          <thead><tr><th>Date</th><th>Remarks</th></tr></thead>
          <tbody>${vax.map(v=>`<tr><td>${v.vaccination_date||'—'}</td><td>${v.remarks||'—'}</td></tr>`).join('')}</tbody>
        </table></div>`}
      </div>
    </div>
  `;
}

// ─── TABLE PAGE ───────────────────────────────────────────────────────────────
async function renderTable(pageKey) {
  const tbl = TABLES[pageKey];
  state.currentTable = pageKey;
  const c = document.getElementById('content');
  const isEmployee = state.role === 'employee';
  const isAdmin    = state.role === 'admin';
  const isHR       = state.role === 'hr';

  c.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">${tbl.label}</div>
        <div class="page-sub">Table: <code>${tbl.name}</code>${isEmployee ? ' <span style="color:var(--text3);font-size:11px">· Read-only</span>' : ''}</div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        ${(tbl.insertable && !isEmployee) ? `<button class="btn btn-primary" onclick="openInsertModal('${pageKey}')">＋ Add Record</button>` : ''}
        ${(isAdmin || isHR) ? `<button class="btn btn-secondary" onclick="openBulkUpload('${pageKey}')">📤 Bulk Upload</button>` : ''}
      </div>
    </div>
    <div class="table-toolbar">
      <div class="search-box">
        <span>🔍</span>
        <input placeholder="Search in results…" id="tbl-search" oninput="onSearch(this.value)">
      </div>
      <div class="emp-filter">
        <span>Emp ID:</span>
        <input placeholder="Filter by emp_id…" id="emp-filter-input"
          value="${isEmployee ? (state.empId||'') : state.empFilter}"
          ${isEmployee ? 'readonly style="cursor:not-allowed;opacity:0.6"' : ''}
          oninput="${isEmployee ? '' : 'onEmpFilter(this.value)'}">
      </div>
      <button class="btn btn-secondary" onclick="refreshTable('${pageKey}')">↺ Refresh</button>
      <div style="margin-left:auto;display:flex;gap:8px">
        <button class="btn btn-secondary" onclick="exportExcelTable()">⬇️ Excel</button>
        <button class="btn btn-secondary" onclick="exportPDFTable()">📄 PDF</button>
        <button class="btn btn-secondary" onclick="exportAllTable('${pageKey}')" title="Export ALL records (ignores pagination)">📥 Export All</button>
      </div>
    </div>
    <div id="table-container"><div class="loading"><div class="spinner"></div> Loading…</div></div>
  `;

  if (isEmployee && state.empId) state.empFilter = state.empId;
  await loadTableData(pageKey);
}

async function loadTableData(pageKey) {
  const tbl  = TABLES[pageKey];
  const cont = document.getElementById('table-container');
  if (!cont) return;

  // If a global search is active, route through the search path instead.
  if (state.search && state.search.trim()) {
    return loadSearchAll(pageKey);
  }

  const params = { page: state.page, pageSize: state.pageSize };
  if (state.empFilter) params.emp_filter = state.empFilter;

  try {
    // 🔒 Data fetch via backend API (server-side paginated — normal browsing mode)
    const res = await tables.list(tbl.name, params);
    const rows = res?.data || [];
    state.searchAllRows = null;          // not in search mode
    state.tableData     = rows;
    state.totalCount    = res?.count || 0;
    renderTableHTML(tbl, rows, pageKey);
  } catch(e) {
    cont.innerHTML = `<div class="empty-state"><div class="icon">⚠️</div>${e.message}</div>`;
  }
}

// ✅ GLOBAL SEARCH: fetch the ENTIRE table once (?all=1), then filter + paginate
// client-side. This fixes the bug where searching only matched the visible page.
async function loadSearchAll(pageKey) {
  const tbl  = TABLES[pageKey];
  const cont = document.getElementById('table-container');
  if (!cont) return;

  // Reuse the cached full dataset if we already fetched it for this table/filter.
  if (state.searchAllRows) { renderSearchPage(pageKey); return; }

  cont.innerHTML = `<div class="loading"><div class="spinner"></div> Searching all records…</div>`;
  const params = { all: '1' };
  if (state.empFilter) params.emp_filter = state.empFilter;

  try {
    const res = await tables.list(tbl.name, params);
    state.searchAllRows = res?.data || [];
    renderSearchPage(pageKey);
  } catch(e) {
    cont.innerHTML = `<div class="empty-state"><div class="icon">⚠️</div>${e.message}</div>`;
  }
}

// Filter the cached full dataset by the search term, then paginate client-side.
function renderSearchPage(pageKey) {
  const tbl = TABLES[pageKey];
  const s   = (state.search || '').trim().toLowerCase();
  const all = state.searchAllRows || [];
  const filtered = s
    ? all.filter(r => Object.values(r).some(v => String(v ?? '').toLowerCase().includes(s)))
    : all;

  state.totalCount = filtered.length;
  const totalPages = Math.max(1, Math.ceil(filtered.length / state.pageSize));
  if (state.page >= totalPages) state.page = totalPages - 1;

  const start    = state.page * state.pageSize;
  const pageRows = filtered.slice(start, start + state.pageSize);
  state.tableData = pageRows;
  renderTableHTML(tbl, pageRows, pageKey);
}

function _origRenderTableHTML(tbl, rows, pageKey) {
  const cont = document.getElementById('table-container');
  if (!cont) return;
  if (rows.length === 0) {
    cont.innerHTML = '<div class="empty-state"><div class="icon">📭</div>No records found</div>';
    return;
  }

  const cols       = tbl.columns;
  const isAdmin    = state.role === 'admin';
  const isEmployee = state.role === 'employee';
  state.exportData = { title: tbl.label, columns: cols, rows: rows.map(r => cols.map(c => r[c]??'')) };

  const totalPages = Math.ceil(state.totalCount / state.pageSize);

  cont.innerHTML = `
    <div class="table-wrap">
      <div style="overflow-x:auto">
        <table class="data-table" id="tbl-export-data">
          <thead><tr>
            ${cols.map(c => `<th>${c.replace(/_/g,' ')}</th>`).join('')}
            ${!isEmployee ? '<th>Actions</th>' : ''}
          </tr></thead>
          <tbody>
            ${rows.map(row => `
              <tr>
                ${cols.map(c => `<td title="${escHtml(String(row[c]??''))}">${formatCell(c, row[c])}</td>`).join('')}
                ${!isEmployee ? `<td style="white-space:nowrap">
                  <button class="btn btn-secondary btn-sm" onclick="openEditModal('${pageKey}', ${JSON.stringify(row).replace(/"/g,'&quot;')})">✏️ Edit</button>
                  ${isAdmin ? `<button class="btn btn-danger btn-sm" style="margin-left:4px" onclick="deleteRow('${pageKey}', '${row[tbl.key]}')">🗑️</button>` : ''}
                </td>` : ''}
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
      <div class="pagination">
        <span>Page ${state.page + 1} of ${totalPages||1} · ${rows.length} records · ${state.totalCount} total</span>
        <div class="pagination-btns">
          <button onclick="changePage(-1)" ${state.page===0?'disabled':''}>← Prev</button>
          <button onclick="changePage(1)"  ${rows.length < state.pageSize?'disabled':''}>Next →</button>
        </div>
      </div>
    </div>
  `;
}

function formatCell(col, val) {
  if (val === null || val === undefined) return '<span style="color:var(--text3)">—</span>';
  if (col === 'is_active') return `<span class="badge ${val?'badge-green':'badge-red'}">${val?'Active':'Inactive'}</span>`;
  if (col === 'status') {
    const colors = { active:'badge-green', exit:'badge-red', approved:'badge-green', pending:'badge-amber', submitted:'badge-blue', draft:'badge-blue', rejected:'badge-red', open:'badge-amber', resolved:'badge-green', 'in progress':'badge-blue' };
    return `<span class="badge ${colors[String(val).toLowerCase()]||'badge-blue'}">${val}</span>`;
  }
  if (typeof val === 'boolean') return val ? '<span class="badge badge-green">Yes</span>' : '<span class="badge badge-red">No</span>';
  const s = String(val);
  return s.length > 60 ? `<span title="${escHtml(s)}">${escHtml(s.slice(0,60))}…</span>` : escHtml(s);
}

function escHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function changePage(d) {
  state.page = Math.max(0, state.page + d);
  // In search mode, just re-slice the cached dataset (no refetch needed).
  if (state.search && state.search.trim() && state.searchAllRows) {
    renderSearchPage(state.currentTable);
  } else {
    loadTableData(state.currentTable);
  }
}

// ✅ FIXED: debounced GLOBAL search across ALL records (not just current page).
function onSearch(v) {
  state.search = v;
  state.page = 0;
  clearTimeout(_searchDebounce);
  _searchDebounce = setTimeout(() => {
    if (state.search && state.search.trim()) {
      loadSearchAll(state.currentTable);          // fetch-all + client filter/paginate
    } else {
      state.searchAllRows = null;                  // exit search mode
      loadTableData(state.currentTable);           // back to server pagination
    }
  }, 300);
}

function onEmpFilter(v) {
  state.empFilter = v;
  state.page = 0;
  state.searchAllRows = null;                       // emp filter changed → refetch dataset
  if (state.search && state.search.trim()) {
    loadSearchAll(state.currentTable);
  } else {
    loadTableData(state.currentTable);
  }
}

// Refresh = drop any cached search dataset and reload from the server.
function refreshTable(pageKey) {
  state.searchAllRows = null;
  loadTableData(pageKey);
}

// ─── BULK UPLOAD ─────────────────────────────────────────────────────────────
function openBulkUpload(pageKey) {
  const tbl = TABLES[pageKey];
  document.getElementById('modal-title').textContent = `📤 Bulk Upload — ${tbl.label}`;
  document.getElementById('modal-body').innerHTML = `
    <div style="margin-bottom:16px">
      <p style="color:var(--text2);font-size:13px;margin-bottom:12px">
        Upload an Excel (.xlsx) file. First row must be column headers matching the table.
        Maximum 2,000 rows per upload.
      </p>
      <button class="btn btn-secondary btn-sm" onclick="downloadBulkTemplate('${pageKey}')">⬇️ Download Template</button>
    </div>
    <div style="border:2px dashed var(--border);border-radius:14px;padding:40px;text-align:center;background:var(--surface2);cursor:pointer" onclick="document.getElementById('bulk-file-input').click()">
      <div style="font-size:40px;margin-bottom:8px">📁</div>
      <div style="font-weight:600;color:var(--text2)">Click to choose Excel file</div>
      <div style="font-size:12px;color:var(--text3);margin-top:4px">.xlsx or .xls</div>
      <input type="file" id="bulk-file-input" accept=".xlsx,.xls" style="display:none" onchange="handleBulkUpload('${pageKey}', this.files[0])">
    </div>
    <div id="bulk-status" style="margin-top:12px;font-size:13px;color:var(--text3)"></div>
  `;
  document.getElementById('modal-save-btn').style.display = 'none';
  document.getElementById('modal-overlay').classList.add('open');
}

// Columns used for the employees bulk template (matches the Add Employee form)
const EMP_BULK_COLS = [
  'emp_id','emp_name','date_of_birth','gender','department','designation',
  'date_of_joining','ctc','ctc_gmc_per_month','gmc_effective_date',
  'gmc_inclusion_date','unit','email_id','mobile_number',
];

function downloadBulkTemplate(pageKey) {
  const tbl = TABLES[pageKey];

  // ✅ Employees get a curated template (clean columns + sample row)
  if (pageKey === 't_employees') {
    const sample = [
      'U3-1445','John Doe','1990-05-15','Male','Finance','Senior Analyst',
      '2020-01-10','600000','2500','2020-01-10','2020-01-10','UNIT-3','john.doe@gcpl.com','9876543210',
    ];
    const ws = XLSX.utils.aoa_to_sheet([EMP_BULK_COLS, sample]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Template');
    XLSX.writeFile(wb, `Employees_template.xlsx`);
    return;
  }

  const header = tbl.columns.filter(c => c !== tbl.key);
  const ws = XLSX.utils.aoa_to_sheet([header]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Template');
  XLSX.writeFile(wb, `${tbl.label}_template.xlsx`);
}

async function handleBulkUpload(pageKey, file) {
  if (!file) return;
  const status = document.getElementById('bulk-status');
  status.textContent = '⏳ Reading file…';

  const reader = new FileReader();
  reader.onload = async (ev) => {
    const wb   = XLSX.read(ev.target.result, { type: 'binary' });
    const ws   = wb.Sheets[wb.SheetNames[0]];
    let rows   = XLSX.utils.sheet_to_json(ws, { defval: '' });

    if (rows.length === 0) { status.textContent = '⚠️ No data rows found'; return; }

    // ✅ Employees: validate + normalize each row before upload
    if (pageKey === 't_employees') {
      const errors = [];
      const cleaned = [];
      rows.forEach((raw, i) => {
        const line = i + 2; // +1 header, +1 for 1-based
        const r = {};
        EMP_BULK_COLS.forEach(c => { r[c] = (raw[c] ?? '').toString().trim(); });

        const gmc = parseFloat(r.ctc_gmc_per_month) || 0;
        const doj = r.date_of_joining;

        // required checks
        ['emp_id','emp_name','date_of_birth','gender','department','designation','date_of_joining','unit','email_id','mobile_number']
          .forEach(k => { if (!r[k]) errors.push(`Row ${line}: ${k} is required`); });
        if (r.ctc === '' || isNaN(parseFloat(r.ctc))) errors.push(`Row ${line}: ctc is required (number)`);
        if (r.email_id && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.email_id)) errors.push(`Row ${line}: invalid email`);
        if (r.mobile_number && !/^\d{10}$/.test(r.mobile_number)) errors.push(`Row ${line}: mobile must be 10 digits`);
        const genderNorm = r.gender.toLowerCase();
        if (!['male','female'].includes(genderNorm)) errors.push(`Row ${line}: gender must be Male or Female`);
        if (!EMP_UNITS.includes(r.unit)) errors.push(`Row ${line}: unit must be one of ${EMP_UNITS.join(', ')}`);

        cleaned.push({
          emp_id:             r.emp_id.toUpperCase(),
          emp_name:           r.emp_name,
          date_of_birth:      r.date_of_birth || null,
          gender:             genderNorm === 'male' ? 'Male' : genderNorm === 'female' ? 'Female' : r.gender,
          department:         r.department,
          designation:        r.designation,
          date_of_joining:    doj || null,
          ctc:                r.ctc === '' ? null : parseFloat(r.ctc),
          ctc_gmc_per_month:  gmc,
          gmc_effective_date: r.gmc_effective_date || (gmc > 0 ? (doj || null) : null),
          gmc_inclusion_date: r.gmc_inclusion_date || (gmc > 0 ? (doj || null) : null),
          is_active:          true,
          unit:               r.unit,
          email_id:           r.email_id,
          mobile_number:      r.mobile_number,
        });
      });

      if (errors.length) {
        status.innerHTML = `<div style="color:var(--danger);max-height:240px;overflow:auto">
          <strong>❌ ${errors.length} validation error(s):</strong><br>${errors.slice(0,30).join('<br>')}
          ${errors.length > 30 ? `<br>… and ${errors.length - 30} more` : ''}</div>`;
        return;
      }
      rows = cleaned;
    }

    status.textContent = `⏳ Uploading ${rows.length} rows…`;
    try {
      // 🔒 Bulk insert via backend — server validates role & data
      const res = await tables.bulkInsert(TABLES[pageKey].name, rows);
      status.innerHTML = `<span style="color:var(--hr)">✅ Successfully imported ${res.inserted} records!</span>`;
      showToast(`Imported ${res.inserted} records!`, 'success');
      state.searchAllRows = null;
      setTimeout(() => { closeModal(); loadTableData(pageKey); }, 1500);
    } catch(e) {
      status.innerHTML = `<span style="color:var(--danger)">❌ ${e.message}</span>`;
      showToast(e.message, 'error');
    }
  };
  reader.readAsBinaryString(file);
}

// ─── MODAL — INSERT / EDIT ────────────────────────────────────────────────────
let modalMode = 'insert', modalPageKey = '', modalRowData = null;

function openInsertModal(pageKey) {
  modalMode = 'insert'; modalPageKey = pageKey; modalRowData = null;
  const tbl = TABLES[pageKey];

  // ✅ Specialized form for the employees table (clean fields, validation, dropdowns)
  if (pageKey === 't_employees') return openEmployeeModal('insert', null);

  document.getElementById('modal-title').textContent = `Add ${tbl.label}`;
  document.getElementById('modal-save-btn').style.display = '';
  document.getElementById('modal-save-btn').onclick = saveModal;
  const body = document.getElementById('modal-body');
  body.innerHTML = `<div class="form-grid">${tbl.columns.filter(c=>c!==tbl.key).map(c=>`
    <div class="form-group">
      <label>${c.replace(/_/g,' ')}</label>
      <input type="text" id="field_${c}" name="${c}" placeholder="${c}">
    </div>
  `).join('')}</div>`;
  document.getElementById('modal-overlay').classList.add('open');
}

function openEditModal(pageKey, row) {
  modalMode = 'edit'; modalPageKey = pageKey; modalRowData = row;
  const tbl = TABLES[pageKey];

  // ✅ Specialized form for the employees table
  if (pageKey === 't_employees') return openEmployeeModal('edit', row);

  document.getElementById('modal-title').textContent = `Edit ${tbl.label}`;
  document.getElementById('modal-save-btn').style.display = '';
  document.getElementById('modal-save-btn').onclick = saveModal;
  const body = document.getElementById('modal-body');
  body.innerHTML = `<div class="form-grid">${tbl.columns.map(c=>`
    <div class="form-group">
      <label>${c.replace(/_/g,' ')}${c===tbl.key?' (key)':''}</label>
      <input type="text" id="field_${c}" value="${escHtml(String(row[c]??''))}" ${c===tbl.key&&state.role!=='admin'?'readonly':''}>
    </div>
  `).join('')}</div>`;
  document.getElementById('modal-overlay').classList.add('open');
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── SPECIALIZED EMPLOYEE FORM (Add / Edit) ──────────────────────────────────
// Only the fields below are shown. Other DB columns (exit_date, exit_type, etc.)
// are intentionally omitted from the form.
// ═══════════════════════════════════════════════════════════════════════════════
const EMP_UNITS = ['UNIT-3','UNIT-1','UNIT-2','UNIT-4','QUEST','GSPL','CORPORATE','OTHERS'];

function openEmployeeModal(mode, row) {
  modalMode = mode; modalPageKey = 't_employees'; modalRowData = row;
  const r = row || {};
  const isAdmin = state.role === 'admin';
  const idReadonly = (mode === 'edit' && !isAdmin) ? 'readonly style="background:var(--surface2);cursor:not-allowed"' : '';
  const val = (k) => escHtml(String(r[k] ?? ''));
  const sel = (k, opt) => (String(r[k] ?? '') === opt ? 'selected' : '');

  document.getElementById('modal-title').textContent = mode === 'insert' ? '➕ Add Employee' : `✏️ Edit Employee — ${val('emp_id')}`;
  document.getElementById('modal-save-btn').style.display = '';
  document.getElementById('modal-save-btn').onclick = saveEmployeeModal;

  document.getElementById('modal-body').innerHTML = `
    <div class="form-grid">
      <div class="form-group">
        <label>Employee ID *</label>
        <input type="text" id="emp_f_emp_id" value="${val('emp_id')}" placeholder="e.g. U3-1445" ${idReadonly}>
      </div>
      <div class="form-group">
        <label>Employee Name *</label>
        <input type="text" id="emp_f_emp_name" value="${val('emp_name')}" placeholder="Full name">
      </div>

      <div class="form-group">
        <label>Date of Birth * <span style="color:var(--text3);font-weight:400">(YYYY-MM-DD)</span></label>
        <input type="date" id="emp_f_date_of_birth" value="${val('date_of_birth')}" max="2099-12-31">
      </div>
      <div class="form-group">
        <label>Gender *</label>
        <select id="emp_f_gender">
          <option value="">Select…</option>
          <option value="Male" ${sel('gender','Male')}>Male</option>
          <option value="Female" ${sel('gender','Female')}>Female</option>
        </select>
      </div>

      <div class="form-group">
        <label>Department *</label>
        <input type="text" id="emp_f_department" value="${val('department')}" placeholder="e.g. Finance">
      </div>
      <div class="form-group">
        <label>Designation *</label>
        <input type="text" id="emp_f_designation" value="${val('designation')}" placeholder="e.g. Manager">
      </div>

      <div class="form-group">
        <label>Date of Joining * <span style="color:var(--text3);font-weight:400">(YYYY-MM-DD)</span></label>
        <input type="date" id="emp_f_date_of_joining" value="${val('date_of_joining')}" oninput="empRecalcGmcDates()">
      </div>
      <div class="form-group">
        <label>Unit *</label>
        <select id="emp_f_unit">
          <option value="">Select…</option>
          ${EMP_UNITS.map(u => `<option value="${u}" ${sel('unit',u)}>${u}</option>`).join('')}
        </select>
      </div>

      <div class="form-group">
        <label>CTC (Annual) *</label>
        <input type="number" id="emp_f_ctc" value="${val('ctc')}" min="0" step="0.01" placeholder="0">
      </div>
      <div class="form-group">
        <label>CTC GMC / Month</label>
        <input type="number" id="emp_f_ctc_gmc_per_month" value="${r.ctc_gmc_per_month ?? 0}" min="0" step="0.01" placeholder="0" oninput="empRecalcGmcDates()">
        <small style="color:var(--text3)">Leave 0 if GMC not applicable</small>
      </div>

      <div class="form-group">
        <label>GMC Effective Date <span style="color:var(--text3);font-weight:400">(auto = DOJ if GMC&gt;0)</span></label>
        <input type="date" id="emp_f_gmc_effective_date" value="${val('gmc_effective_date')}">
      </div>
      <div class="form-group">
        <label>GMC Inclusion Date <span style="color:var(--text3);font-weight:400">(auto = DOJ if GMC&gt;0)</span></label>
        <input type="date" id="emp_f_gmc_inclusion_date" value="${val('gmc_inclusion_date')}">
      </div>

      <div class="form-group">
        <label>Email ID *</label>
        <input type="email" id="emp_f_email_id" value="${val('email_id')}" placeholder="name@example.com" oninput="empValidateEmail()">
        <small id="emp_email_msg" style="color:var(--text3)"></small>
      </div>
      <div class="form-group">
        <label>Mobile Number *</label>
        <input type="tel" id="emp_f_mobile_number" value="${val('mobile_number')}" maxlength="10" placeholder="10 digits"
          oninput="this.value=this.value.replace(/[^0-9]/g,'').slice(0,10)">
        <small style="color:var(--text3)">10 digits only</small>
      </div>
    </div>
  `;
  document.getElementById('modal-overlay').classList.add('open');
}

// Auto-fill GMC dates from DOJ when CTC GMC > 0 (only if the field is empty,
// so a manual override is never clobbered).
function empRecalcGmcDates() {
  const gmc = parseFloat(document.getElementById('emp_f_ctc_gmc_per_month')?.value) || 0;
  const doj = document.getElementById('emp_f_date_of_joining')?.value || '';
  const eff = document.getElementById('emp_f_gmc_effective_date');
  const inc = document.getElementById('emp_f_gmc_inclusion_date');
  if (gmc > 0 && doj) {
    if (eff && !eff.value) eff.value = doj;
    if (inc && !inc.value) inc.value = doj;
  } else if (gmc <= 0) {
    if (eff) eff.value = '';
    if (inc) inc.value = '';
  }
}

function empValidateEmail() {
  const el  = document.getElementById('emp_f_email_id');
  const msg = document.getElementById('emp_email_msg');
  const v   = el.value.trim();
  const ok  = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
  if (!v) { msg.textContent = ''; return true; }
  msg.textContent = ok ? '✅ Valid' : '❌ Invalid email format';
  msg.style.color = ok ? 'var(--hr,#059669)' : 'var(--danger,#dc2626)';
  return ok;
}

async function saveEmployeeModal() {
  const g = (id) => document.getElementById(id)?.value ?? '';
  const gmc = parseFloat(g('emp_f_ctc_gmc_per_month')) || 0;
  const doj = g('emp_f_date_of_joining').trim();

  const data = {
    emp_id:             g('emp_f_emp_id').trim().toUpperCase(),
    emp_name:           g('emp_f_emp_name').trim(),
    date_of_birth:      g('emp_f_date_of_birth').trim() || null,
    gender:             g('emp_f_gender'),
    department:         g('emp_f_department').trim(),
    designation:        g('emp_f_designation').trim(),
    date_of_joining:    doj || null,
    ctc:                g('emp_f_ctc') === '' ? null : parseFloat(g('emp_f_ctc')),
    ctc_gmc_per_month:  gmc,
    gmc_effective_date: g('emp_f_gmc_effective_date').trim() || (gmc > 0 ? (doj || null) : null),
    gmc_inclusion_date: g('emp_f_gmc_inclusion_date').trim() || (gmc > 0 ? (doj || null) : null),
    is_active:          true,                       // always active by default
    unit:               g('emp_f_unit'),
    email_id:           g('emp_f_email_id').trim(),
    mobile_number:      g('emp_f_mobile_number').trim(),
  };

  // ── Validation ──
  const required = {
    emp_id: 'Employee ID', emp_name: 'Employee Name', date_of_birth: 'Date of Birth',
    gender: 'Gender', department: 'Department', designation: 'Designation',
    date_of_joining: 'Date of Joining', unit: 'Unit', email_id: 'Email ID', mobile_number: 'Mobile Number',
  };
  for (const [k, label] of Object.entries(required)) {
    if (!data[k]) { showToast(`${label} is required`, 'error'); return; }
  }
  if (data.ctc === null || isNaN(data.ctc)) { showToast('CTC is required', 'error'); return; }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email_id)) { showToast('Invalid email format', 'error'); return; }
  if (!/^\d{10}$/.test(data.mobile_number)) { showToast('Mobile number must be exactly 10 digits', 'error'); return; }
  if (!EMP_UNITS.includes(data.unit)) { showToast('Please select a valid Unit', 'error'); return; }

  try {
    if (modalMode === 'insert') {
      await tables.insert('employees', data);
    } else {
      const keyVal = modalRowData[TABLES.t_employees.key]; // 'id'
      await tables.update('employees', keyVal, data, TABLES.t_employees.key);
    }
    showToast(modalMode === 'insert' ? 'Employee added!' : 'Employee updated!', 'success');
    closeModal();
    state.searchAllRows = null;          // invalidate search cache
    loadTableData('t_employees');
  } catch(e) {
    showToast(e.message, 'error');
  }
}

function closeModal() {
  document.getElementById('modal-overlay').classList.remove('open');
  document.getElementById('modal-save-btn').style.display = '';
  document.getElementById('modal-save-btn').onclick = saveModal;
}

async function saveModal() {
  const tbl  = TABLES[modalPageKey];
  const data = {};
  tbl.columns.forEach(c => {
    const el = document.getElementById('field_' + c);
    if (el) data[c] = el.value === '' ? null : el.value;
  });

  try {
    if (modalMode === 'insert') {
      delete data[tbl.key];
      // 🔒 Insert via backend
      await tables.insert(tbl.name, data);
    } else {
      const keyVal = modalRowData[tbl.key];
      // 🔒 Update via backend — keyCol passed for non-id PKs
      await tables.update(tbl.name, keyVal, data, tbl.key);
    }
    showToast(modalMode === 'insert' ? 'Record added!' : 'Record updated!', 'success');
    closeModal();
    loadTableData(modalPageKey);
  } catch(e) {
    showToast(e.message, 'error');
  }
}

async function deleteRow(pageKey, keyVal) {
  if (state.role !== 'admin') { showToast('Only admins can delete', 'error'); return; }
  if (!confirm('Delete this record? This cannot be undone.')) return;
  const tbl = TABLES[pageKey];
  try {
    // 🔒 Delete via backend
    await tables.remove(tbl.name, keyVal, tbl.key);
    showToast('Record deleted', 'success');
    loadTableData(pageKey);
  } catch(e) {
    showToast(e.message, 'error');
  }
}

// ─── EXPORT ───────────────────────────────────────────────────────────────────
function exportExcelTable() { if (state.exportData) doExportExcel(state.exportData); else showToast('Load data first','error'); }
function exportPDFTable()   { if (state.exportData) doExportPDF(state.exportData); else showToast('Load data first','error'); }

async function exportAllTable(pageKey) {
  const tbl = TABLES[pageKey];
  if (!tbl) return;
  showToast('Fetching all records…', 'info');
  try {
    // Use export endpoint which fetches up to 5000 rows (all records, no pagination)
    const params = {};
    if (state.empFilter) params.emp_filter = state.empFilter;
    const res = await exportData.table(tbl.name, { ...params, columns: tbl.columns });
    const rows = res?.data || [];
    if (!rows.length) { showToast('No data to export', 'error'); return; }
    const cols = tbl.columns;
    const data = { title: tbl.label + '_ALL', columns: cols, rows: rows.map(r => cols.map(c => r[c]??'')) };
    doExportExcel(data);
    showToast(`Exported ${rows.length} records!`, 'success');
  } catch(e) {
    showToast('Export failed: ' + e.message, 'error');
  }
}

function doExportExcel(data) {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([ data.columns.map(c=>c.replace(/_/g,' ')), ...data.rows ]);
  XLSX.utils.book_append_sheet(wb, ws, data.title.substring(0,31));
  XLSX.writeFile(wb, `${data.title}_${new Date().toISOString().slice(0,10)}.xlsx`);
  showToast('Excel exported!', 'success');
}

function doExportPDF(data) {
  const doc = new jsPDF({ orientation: data.columns.length > 8 ? 'landscape':'portrait', unit:'mm', format:'a4' });
  doc.setFontSize(14); doc.setFont('helvetica','bold');
  doc.text(data.title, 14, 15);
  doc.setFontSize(8); doc.setFont('helvetica','normal');
  doc.text(`Generated: ${new Date().toLocaleString()} | ${data.rows.length} records | insurance-portal.in`, 14, 22);
  doc.autoTable({
    head: [data.columns.map(c=>c.replace(/_/g,' '))],
    body: data.rows.map(r => r.map(v => String(v??''))),
    startY: 28,
    styles: { fontSize: 7, cellPadding: 2 },
    headStyles: { fillColor: [29,78,216], textColor:255, fontStyle:'bold' },
    alternateRowStyles: { fillColor: [240,244,255] },
    margin: { left:14, right:14 },
  });
  doc.save(`${data.title}_${new Date().toISOString().slice(0,10)}.pdf`);
  showToast('PDF exported!', 'success');
}

// ─── VIEWS PAGE ───────────────────────────────────────────────────────────────
let viewState = { selectedView: null, data: [], search: '', page: 0, pageSize: 50, filterValue: '', categoryFilter: 'All' };

function renderViewsPage() {
  const c = document.getElementById('content');
  c.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">Database Views</div>
        <div class="page-sub">${VIEWS.length} views · Filter by Emp_ID or category</div>
      </div>
    </div>
    <div class="tabs" id="view-cat-tabs">
      ${VIEW_CATEGORIES.map(cat=>`<button class="tab-btn ${cat==='All'?'active':''}" onclick="filterViewsByCategory('${cat}', this)">${cat}</button>`).join('')}
    </div>
    <div class="views-grid" id="views-grid" style="margin-bottom:24px">
      ${VIEWS.map(v => {
        const meta = VIEW_META[v.key] || {};
        return `
        <div class="view-card ${viewState.selectedView===v.key?'selected':''}" id="vcard-${v.key}" data-cat="${meta.category||'Other'}" onclick="selectView('${v.key}')">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
            <span style="font-size:18px">${meta.icon||'📊'}</span>
            <div class="view-card-title" style="font-size:12px">${v.label}</div>
          </div>
          <div style="display:flex;gap:6px;align-items:center">
            <span class="badge ${meta.filterCol?'badge-blue':'badge-amber'}" style="font-size:10px;padding:1px 6px">${meta.category||'Other'}</span>
            <span style="font-size:10px;color:var(--text3)">${meta.filterCol?'🔍 Emp ID filter':'📊 Summary'}</span>
          </div>
        </div>`;
      }).join('')}
    </div>
    <div id="view-data-panel" style="display:none">
      <div style="background:white;border:1px solid var(--border);border-radius:14px;padding:20px;margin-bottom:20px;box-shadow:var(--shadow-sm)">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:12px">
          <div>
            <div id="view-panel-title" style="font-size:16px;font-weight:700;color:#0f172a"></div>
            <div id="view-panel-sub" style="font-size:12px;color:var(--text3);margin-top:2px"></div>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button class="btn btn-secondary btn-sm" onclick="refreshCurrentView()">↺ Refresh</button>
            <button class="btn btn-secondary btn-sm" onclick="exportViewExcel()">⬇️ Excel</button>
            <button class="btn btn-secondary btn-sm" onclick="exportViewPDF()">📄 PDF</button>
            <button class="btn btn-secondary btn-sm" onclick="closeViewPanel()">✕ Close</button>
          </div>
        </div>
        <div class="table-toolbar" id="view-filter-bar" style="margin-bottom:0;border-radius:10px">
          <div class="search-box">
            <span>🔍</span>
            <input placeholder="Search in results…" id="view-search" oninput="onViewSearch(this.value)">
          </div>
          <div id="view-emp-filter-wrap"></div>
        </div>
      </div>
      <div id="view-table-container"></div>
    </div>
  `;
}

function filterViewsByCategory(cat, btn) {
  viewState.categoryFilter = cat;
  document.querySelectorAll('#view-cat-tabs .tab-btn').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  document.querySelectorAll('#views-grid .view-card').forEach(card => {
    card.style.display = (cat === 'All' || card.dataset.cat === cat) ? '' : 'none';
  });
}

function selectView(viewKey) {
  viewState.selectedView = viewKey;
  viewState.page = 0;
  viewState.filterValue = state.role === 'employee' ? (state.empId||'') : '';
  viewState.search = '';

  document.querySelectorAll('.view-card').forEach(el => el.classList.remove('selected'));
  document.getElementById('vcard-'+viewKey)?.classList.add('selected');

  const panel = document.getElementById('view-data-panel');
  panel.style.display = 'block';

  const meta  = VIEW_META[viewKey] || {};
  const vInfo = VIEWS.find(v=>v.key===viewKey);
  document.getElementById('view-panel-title').textContent = (meta.icon||'📊') + ' ' + (vInfo?.label||viewKey);
  document.getElementById('view-panel-sub').textContent = `View: ${viewKey}`;

  if (meta.filterCol) {
    document.getElementById('view-emp-filter-wrap').innerHTML = `
      <div class="emp-filter">
        <span>Emp ID:</span>
        <input id="view-col-filter" placeholder="Enter Emp ID…" value="${viewState.filterValue}"
          ${state.role==='employee'?'readonly style="cursor:not-allowed;opacity:0.6"':''}
          oninput="viewState.filterValue=this.value">
      </div>
      <button class="btn btn-primary btn-sm" onclick="fetchViewData('${viewKey}')">Apply</button>
      <button class="btn btn-secondary btn-sm" onclick="document.getElementById('view-col-filter').value='';viewState.filterValue='';fetchViewData('${viewKey}')">Clear</button>
    `;
  } else {
    document.getElementById('view-emp-filter-wrap').innerHTML = '';
  }

  panel.scrollIntoView({ behavior: 'smooth' });
  fetchViewData(viewKey);
}

async function fetchViewData(viewKey) {
  const cont = document.getElementById('view-table-container');
  if (!cont) return;
  cont.innerHTML = '<div class="loading"><div class="spinner"></div> Loading view data…</div>';

  const meta = VIEW_META[viewKey] || {};
  const params = {};
  if (meta.filterCol && viewState.filterValue) params.emp_filter = viewState.filterValue;

  try {
    // 🔒 View data via backend
    const res  = await views.fetch(viewKey, params);
    const data = res?.data || [];
    if (data.length === 0) {
      cont.innerHTML = `<div class="empty-state"><div class="icon">📭</div>No data found${viewState.filterValue?' for '+viewState.filterValue:''}.</div>`;
      return;
    }
    viewState.data = data; viewState.search = '';
    renderViewTable(data, viewKey);
  } catch(e) {
    cont.innerHTML = `<div class="empty-state"><div class="icon">⚠️</div>${e.message}</div>`;
  }
}

function onViewSearch(val) {
  viewState.search = val;
  const filtered = val ? viewState.data.filter(r=>Object.values(r).some(v=>String(v??'').toLowerCase().includes(val.toLowerCase()))) : viewState.data;
  renderViewTable(filtered, viewState.selectedView);
}

function renderViewTable(rows, viewKey) {
  const cont = document.getElementById('view-table-container');
  if (!cont || !rows.length) return;
  const cols = Object.keys(rows[0]);
  state.exportData = { title: VIEWS.find(v=>v.key===viewKey)?.label||viewKey, columns: cols, rows: rows.map(r=>cols.map(c=>r[c]??'')) };
  const pageRows = rows.slice(viewState.page * viewState.pageSize, (viewState.page+1) * viewState.pageSize);
  document.getElementById('view-panel-sub').textContent = `View: ${viewKey} · ${rows.length} rows${viewState.filterValue?' · filtered: '+viewState.filterValue:''}`;
  cont.innerHTML = `
    <div class="table-wrap">
      <div style="overflow-x:auto">
        <table class="data-table">
          <thead><tr>${cols.map(c=>`<th>${c.replace(/_/g,' ')}</th>`).join('')}</tr></thead>
          <tbody>${pageRows.map(row=>`<tr>${cols.map(c=>`<td title="${escHtml(String(row[c]??''))}">${formatCell(c,row[c])}</td>`).join('')}</tr>`).join('')}</tbody>
        </table>
      </div>
      <div class="pagination">
        <span>Page ${viewState.page+1} · ${pageRows.length} of ${rows.length} rows</span>
        <div class="pagination-btns">
          <button onclick="changeViewPage(-1)" ${viewState.page===0?'disabled':''}>← Prev</button>
          <button onclick="changeViewPage(1)" ${(viewState.page+1)*viewState.pageSize>=rows.length?'disabled':''}>Next →</button>
        </div>
      </div>
    </div>
  `;
}

function changeViewPage(d) {
  viewState.page = Math.max(0, viewState.page + d);
  const filtered = viewState.search ? viewState.data.filter(r=>Object.values(r).some(v=>String(v??'').toLowerCase().includes(viewState.search.toLowerCase()))) : viewState.data;
  renderViewTable(filtered, viewState.selectedView);
}
function refreshCurrentView() { if (viewState.selectedView) fetchViewData(viewState.selectedView); }
function closeViewPanel() {
  document.getElementById('view-data-panel').style.display = 'none';
  document.querySelectorAll('.view-card').forEach(el=>el.classList.remove('selected'));
  viewState.selectedView = null;
}
function exportViewExcel() { if (state.exportData) doExportExcel(state.exportData); }
function exportViewPDF()   { if (state.exportData) doExportPDF(state.exportData); }

// ─── EMPLOYEE FULL VIEW ───────────────────────────────────────────────────────
function renderEmpFullView() {
  const c = document.getElementById('content');
  const defaultEmpId = state.role === 'employee' ? (state.empId||'') : '';
  c.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">🔎 Employee Full View</div>
        <div class="page-sub">Enter an Emp ID to see all data across every table and view</div>
      </div>
    </div>
    <div class="section-card">
      <div style="display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap">
        <div style="flex:1;min-width:200px">
          <label style="font-size:11px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.5px;display:block;margin-bottom:6px">Employee ID</label>
          <input id="efv-empid" type="text" value="${defaultEmpId}"
            ${state.role==='employee'?'readonly style="cursor:not-allowed;background:var(--surface2);border:1.5px solid var(--border);border-radius:9px;padding:9px 12px;font-size:14px;width:100%"':''}
            ${state.role!=='employee'?'style="background:var(--surface2);border:1.5px solid var(--border);border-radius:9px;padding:9px 12px;font-size:15px;font-weight:600;font-family:\'DM Mono\',monospace;width:100%;outline:none" placeholder="e.g. EMP001" onkeydown="if(event.key===\'Enter\')loadEmpFullView()"':''}
          >
        </div>
        <button class="btn btn-primary" onclick="loadEmpFullView()" style="height:42px;padding:0 24px">🔎 Load</button>
        <button class="btn btn-secondary" id="efv-export-excel" style="height:42px;display:none" onclick="exportEmpFullExcel()">⬇️ Excel</button>
        <button class="btn btn-secondary" id="efv-export-pdf" style="height:42px;display:none" onclick="exportEmpFullPDF()">📄 PDF</button>
      </div>
    </div>
    <div id="efv-content"></div>
  `;
  if (defaultEmpId) setTimeout(() => loadEmpFullView(), 100);
}

let empFullData = {};

async function loadEmpFullView() {
  const empId = document.getElementById('efv-empid')?.value?.trim();
  if (!empId) { showToast('Please enter an Emp ID', 'error'); return; }

  const cont = document.getElementById('efv-content');
  cont.innerHTML = `<div class="loading"><div class="spinner"></div> Loading all data for ${empId}…</div>`;

  try {
    // 🔒 Single backend call — fetches all tables+views, enforces ownership
    const result = await views.employeeFull(empId);
    const data   = result?.data || {};
    const emp    = data.employees?.[0];

    if (!emp) {
      cont.innerHTML = `<div class="empty-state"><div class="icon">🔍</div>No employee found with Emp ID: <b>${empId}</b></div>`;
      return;
    }

    empFullData = {
      empId, empName: emp?.emp_name || empId,
      sections: Object.entries(data).map(([key, rows]) => ({
        title: key.replace(/^vw_/, '').replace(/_/g,' ').replace(/\b\w/g, l => l.toUpperCase()),
        key,
        data: Array.isArray(rows) ? rows : [],
        cols: Array.isArray(rows) && rows[0] ? Object.keys(rows[0]) : [],
      })).filter(s => s.data.length > 0),
    };

    document.getElementById('efv-export-excel').style.display = '';
    document.getElementById('efv-export-pdf').style.display = '';

    const withData = empFullData.sections;
    cont.innerHTML = `
      <div class="info-panel" style="margin-bottom:20px">
        <div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap">
          <div style="width:48px;height:48px;border-radius:12px;background:linear-gradient(135deg,#1d4ed8,#0284c7);display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:800;color:white;flex-shrink:0">
            ${(emp.emp_name||empId)[0].toUpperCase()}
          </div>
          <div style="flex:1">
            <div style="font-size:20px;font-weight:800;color:#0f172a">${emp.emp_name||empId}</div>
            <div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:4px">
              <code>${empId}</code>
              ${emp.department?`<span style="color:var(--text2);font-size:13px">· ${emp.department}</span>`:''}
              ${emp.designation?`<span style="color:var(--text2);font-size:13px">· ${emp.designation}</span>`:''}
            </div>
          </div>
          <div style="display:flex;gap:16px;flex-wrap:wrap">
            <div style="text-align:center"><div style="font-size:11px;color:var(--text3);font-weight:600">SECTIONS</div><div style="font-size:22px;font-weight:800;color:#1d4ed8">${withData.length}</div></div>
          </div>
        </div>
      </div>
      ${withData.map(sec => `
        <div class="section-card" style="margin-bottom:16px">
          <div class="section-title">📋 ${sec.title} <span style="color:var(--text3);font-size:12px;font-weight:400">(${sec.data.length} row${sec.data.length!==1?'s':''})</span></div>
          <div style="overflow-x:auto">
            <table class="data-table">
              <thead><tr>${sec.cols.map(c=>`<th>${c.replace(/_/g,' ')}</th>`).join('')}</tr></thead>
              <tbody>${sec.data.map(row=>`<tr>${sec.cols.map(c=>`<td title="${escHtml(String(row[c]??''))}">${formatCell(c,row[c])}</td>`).join('')}</tr>`).join('')}</tbody>
            </table>
          </div>
        </div>
      `).join('')}
    `;
  } catch(e) {
    cont.innerHTML = `<div class="empty-state"><div class="icon">⚠️</div>${e.message}</div>`;
  }
}

function exportEmpFullExcel() {
  if (!empFullData.sections) return;
  const wb = XLSX.utils.book_new();
  const sumWs = XLSX.utils.aoa_to_sheet([['Employee Full Report'], ['Emp ID:', empFullData.empId], ['Name:', empFullData.empName], ['Generated:', new Date().toLocaleString()]]);
  XLSX.utils.book_append_sheet(wb, sumWs, 'Summary');
  empFullData.sections.forEach(sec => {
    if (!sec.data.length) return;
    const name = sec.title.replace(/[^a-zA-Z0-9 ]/g,'').trim().substring(0,31);
    const ws = XLSX.utils.aoa_to_sheet([sec.cols, ...sec.data.map(r=>sec.cols.map(c=>r[c]??''))]);
    XLSX.utils.book_append_sheet(wb, ws, name);
  });
  XLSX.writeFile(wb, `Employee_${empFullData.empId}_${new Date().toISOString().slice(0,10)}.xlsx`);
}

function exportEmpFullPDF() {
  if (!empFullData.sections) return;
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  let y = 15;
  doc.setFontSize(16); doc.setFont('helvetica','bold');
  doc.text(`Employee Report — ${empFullData.empName} (${empFullData.empId})`, 14, y); y += 10;
  empFullData.sections.forEach(sec => {
    if (!sec.data.length) return;
    if (y > 170) { doc.addPage(); y = 15; }
    doc.setFontSize(10); doc.setFont('helvetica','bold');
    doc.text(sec.title, 14, y); y += 6;
    doc.autoTable({
      head: [sec.cols.map(c=>c.replace(/_/g,' '))],
      body: sec.data.map(r=>sec.cols.map(c=>String(r[c]??''))),
      startY: y, margin: { left:14, right:14 },
      styles: { fontSize: 6, cellPadding: 1.5 },
      headStyles: { fillColor: [29,78,216], textColor: 255, fontStyle: 'bold' },
      alternateRowStyles: { fillColor: [240,244,255] },
      didDrawPage: (d) => { y = d.cursor.y + 8; },
    });
    y = doc.lastAutoTable.finalY + 10;
  });
  doc.save(`Employee_${empFullData.empId}_${new Date().toISOString().slice(0,10)}.pdf`);
}

// ─── CORRECTION CONCERNS ──────────────────────────────────────────────────────
async function renderConcernsPage() {
  const c = document.getElementById('content');
  const isEmployee = state.role === 'employee';

  c.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">📝 Correction Concerns</div>
        <div class="page-sub">${isEmployee ? 'Raise a concern if any of your data is incorrect' : 'Employee data correction requests'}</div>
      </div>
      ${isEmployee ? `<button class="btn btn-primary" onclick="openNewConcernModal()">✍️ Raise Concern</button>` : `<div style="display:flex;gap:8px"><button class="btn btn-secondary" onclick="exportConcernsExcel()">⬇️ Excel</button><button class="btn btn-secondary" onclick="exportConcernsPDF()">📄 PDF</button></div>`}
    </div>
    <div id="concerns-container"><div class="loading"><div class="spinner"></div> Loading concerns…</div></div>
  `;

  await loadConcerns();
}

let concernsData = [];

async function loadConcerns() {
  const cont = document.getElementById('concerns-container');
  if (!cont) return;

  try {
    const params = {};
    if (state.role === 'employee') params.emp_filter = state.empId;
    // 🔒 Fetch concerns via backend
    const res  = await tables.list('user_concerns', params);
    concernsData = res?.data || [];

    if (concernsData.length === 0) {
      cont.innerHTML = '<div class="empty-state"><div class="icon">📭</div>No concerns raised yet' + (state.role==='employee'?' — use the button above to raise one.':'') + '</div>';
      return;
    }

    cont.innerHTML = concernsData.map(concern => `
      <div class="concern-card ${(concern.status||'open').toLowerCase().replace(' ','-')}">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap">
          <div style="flex:1">
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px">
              <code>${concern.emp_id||'—'}</code>
              ${concern.table_name ? `<span class="badge badge-blue" style="font-size:11px">${concern.table_name}</span>` : ''}
              <span class="badge ${concern.status==='Resolved'?'badge-green':concern.status==='In Progress'?'badge-blue':'badge-amber'}">${concern.status||'Open'}</span>
              <span style="font-size:11px;color:var(--text3)">${concern.created_at ? new Date(concern.created_at).toLocaleDateString('en-IN') : ''}</span>
            </div>
            <p style="font-size:13px;color:var(--text2);line-height:1.6">${escHtml(concern.description||'')}</p>
            ${concern.admin_response ? `
              <div style="margin-top:12px;background:#d1fae5;border:1px solid #a7f3d0;border-radius:10px;padding:10px 14px">
                <div style="font-size:11px;font-weight:700;color:#065f46;margin-bottom:4px">HR / Admin Response:</div>
                <p style="font-size:13px;color:#047857">${escHtml(concern.admin_response)}</p>
              </div>` : ''}
          </div>
          ${(state.role === 'admin' || state.role === 'hr') && concern.status !== 'Resolved' ? `
            <button class="btn btn-success btn-sm" onclick="openRespondModal(${concern.id}, '${escHtml(concern.description||'')}')">💬 Respond</button>
          ` : ''}
        </div>
      </div>
    `).join('');
  } catch(e) {
    cont.innerHTML = `<div class="empty-state"><div class="icon">⚠️</div>${e.message}</div>`;
  }
}

function openNewConcernModal() {
  document.getElementById('modal-title').textContent = '✍️ Raise Correction Concern';
  document.getElementById('modal-save-btn').style.display = '';
  document.getElementById('modal-save-btn').onclick = submitConcern;
  document.getElementById('modal-body').innerHTML = `
    <div class="form-grid">
      <div class="form-group full">
        <label>Which table/section has incorrect data?</label>
        <select id="concern-table">
          <option value="">— Select (optional) —</option>
          ${Object.values(TABLES).map(t=>`<option value="${t.name}">${t.label}</option>`).join('')}
        </select>
      </div>
      <div class="form-group full">
        <label>Describe the correction needed</label>
        <textarea id="concern-description" placeholder="e.g. My dependent's date of birth is wrong. It should be 1985-06-15 not 1985-06-16." rows="5"></textarea>
      </div>
    </div>
  `;
  document.getElementById('modal-overlay').classList.add('open');
}

async function submitConcern() {
  const description = document.getElementById('concern-description')?.value?.trim();
  const table_name  = document.getElementById('concern-table')?.value || null;
  if (!description) { showToast('Please describe the correction needed', 'error'); return; }

  try {
    // 🔒 Backend enforces emp_id = logged-in employee
    await tables.insert('user_concerns', { emp_id: state.empId, table_name, description });
    showToast('Concern submitted! HR will review soon.', 'success');
    closeModal();
    loadConcerns();
  } catch(e) {
    showToast(e.message, 'error');
  }
}

function openRespondModal(concernId, description) {
  document.getElementById('modal-title').textContent = '💬 Respond to Concern';
  document.getElementById('modal-save-btn').style.display = '';
  document.getElementById('modal-save-btn').onclick = () => submitResponse(concernId);
  document.getElementById('modal-body').innerHTML = `
    <div style="background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:12px 14px;margin-bottom:16px;font-size:13px;color:var(--text2)">${escHtml(description)}</div>
    <div class="form-grid">
      <div class="form-group full">
        <label>Your Response</label>
        <textarea id="concern-response" placeholder="Provide details about the correction or resolution…" rows="4"></textarea>
      </div>
      <div class="form-group">
        <label>Update Status</label>
        <select id="concern-status">
          <option value="In Progress">In Progress</option>
          <option value="Resolved">Resolved</option>
          <option value="Open">Open</option>
        </select>
      </div>
    </div>
  `;
  document.getElementById('modal-overlay').classList.add('open');
}

async function submitResponse(concernId) {
  const response = document.getElementById('concern-response')?.value?.trim();
  const status   = document.getElementById('concern-status')?.value || 'In Progress';
  if (!response) { showToast('Please enter a response', 'error'); return; }

  try {
    await tables.update('user_concerns', concernId, { admin_response: response, status });
    showToast('Response saved!', 'success');
    closeModal();
    loadConcerns();
  } catch(e) {
    showToast(e.message, 'error');
  }
}

function exportConcernsExcel() {
  if (!concernsData.length) return;
  const cols = ['emp_id','table_name','description','status','admin_response','created_at'];
  doExportExcel({ title: 'Correction Concerns', columns: cols, rows: concernsData.map(r=>cols.map(c=>r[c]??'')) });
}
function exportConcernsPDF() {
  if (!concernsData.length) return;
  const cols = ['emp_id','table_name','description','status','admin_response','created_at'];
  doExportPDF({ title: 'Correction Concerns', columns: cols, rows: concernsData.map(r=>cols.map(c=>r[c]??'')) });
}

// ─── USER MANAGEMENT ──────────────────────────────────────────────────────────
async function renderUserManagement() {
  if (state.role !== 'admin') { document.getElementById('content').innerHTML = '<div class="empty-state"><div class="icon">🔒</div>Admin only</div>'; return; }
  const c = document.getElementById('content');
  c.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">User Management</div>
        <div class="page-sub">Manage Admin, HR, and Employee accounts</div>
      </div>
      <button class="btn btn-primary" onclick="openInviteModal()">＋ Invite User</button>
    </div>
    <div class="tabs">
      <button class="tab-btn active" onclick="filterUsers('all', this)">All Users</button>
      <button class="tab-btn" onclick="filterUsers('admin', this)">👑 Admins</button>
      <button class="tab-btn" onclick="filterUsers('hr', this)">👤 HR</button>
      <button class="tab-btn" onclick="filterUsers('employee', this)">🏷️ Employees</button>
    </div>
    <div id="users-list"><div class="loading"><div class="spinner"></div> Loading users…</div></div>
  `;
  await loadUsers('all');
}

let allUsers = [];
async function loadUsers(filter) {
  const el = document.getElementById('users-list');
  if (!el) return;
  try {
    // 🔒 User list from backend admin API
    const res = await admin.users.list();
    allUsers = res?.data || [];
    renderUsers(filter);
  } catch(e) {
    el.innerHTML = `<div class="empty-state"><div class="icon">⚠️</div>${e.message}</div>`;
  }
}

function filterUsers(f, btn) {
  document.querySelectorAll('.tab-btn').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  renderUsers(f);
}

function renderUsers(filter) {
  const el = document.getElementById('users-list');
  if (!el) return;
  let users = filter === 'all' ? allUsers : allUsers.filter(u => u.role === filter);
  if (!users.length) { el.innerHTML = '<div class="empty-state"><div class="icon">👤</div>No users found</div>'; return; }
  const roleColors = { admin:'badge-purple', hr:'badge-green', employee:'badge-amber' };
  el.innerHTML = users.map(u => `
    <div class="user-card">
      <div class="user-avatar ${u.role||'employee'}">${(u.full_name||u.email||'U')[0].toUpperCase()}</div>
      <div class="user-info">
        <div class="user-name">${u.full_name||'—'}</div>
        <div class="user-email" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:3px">
          ${u.emp_id?`<code>${u.emp_id}</code>`:'<span style="color:var(--text3);font-size:11px">No Emp ID</span>'}
          · <span style="font-size:11px;color:var(--text3)">${u.email||''}</span>
          · <span class="badge ${roleColors[u.role]||'badge-blue'}" style="padding:1px 8px">${u.role}</span>
          ${!u.is_active?'<span class="badge badge-red" style="padding:1px 8px">Inactive</span>':''}
        </div>
      </div>
      <div class="user-actions">
        <select onchange="changeUserRole('${u.id}', this.value)" style="background:var(--surface2);border:1.5px solid var(--border);color:var(--text);padding:6px 10px;border-radius:8px;font-size:12px;cursor:pointer;font-family:inherit">
          <option value="employee" ${u.role==='employee'?'selected':''}>Employee</option>
          <option value="hr" ${u.role==='hr'?'selected':''}>HR</option>
          <option value="admin" ${u.role==='admin'?'selected':''}>Admin</option>
        </select>
        <button class="btn btn-secondary btn-sm" onclick="editUserEmpId('${u.id}', '${u.emp_id||''}')">🔗 Emp ID</button>
        <button class="btn btn-secondary btn-sm" onclick="resetUserPassword('${u.id}')">🔑 Reset Pwd</button>
        <button class="btn ${u.is_active?'btn-danger':'btn-success'} btn-sm" onclick="toggleUserActive('${u.id}', ${u.is_active})">${u.is_active?'Deactivate':'Activate'}</button>
      </div>
    </div>
  `).join('');
}

async function changeUserRole(userId, newRole) {
  try {
    await admin.users.update(userId, { role: newRole });
    showToast(`Role updated to ${newRole}`, 'success');
    loadUsers('all');
  } catch(e) { showToast(e.message, 'error'); }
}

async function toggleUserActive(userId, current) {
  try {
    await admin.users.update(userId, { is_active: !current });
    showToast(`User ${current?'deactivated':'activated'}`, 'success');
    loadUsers('all');
  } catch(e) { showToast(e.message, 'error'); }
}

function editUserEmpId(userId, currentEmpId) {
  document.getElementById('modal-title').textContent = 'Link Employee ID';
  document.getElementById('modal-save-btn').style.display = '';
  document.getElementById('modal-body').innerHTML = `
    <div class="form-grid">
      <div class="form-group full">
        <label>Employee ID (emp_id)</label>
        <input type="text" id="field_link_empid" value="${currentEmpId}" placeholder="e.g. EMP001">
        <small>Links this account to an employee record. Required for Employee role access.</small>
      </div>
    </div>
  `;
  document.getElementById('modal-save-btn').onclick = async () => {
    const empId = document.getElementById('field_link_empid').value.trim();
    try {
      await admin.users.update(userId, { emp_id: empId });
      showToast('Employee ID linked!', 'success');
      closeModal();
      loadUsers('all');
    } catch(e) { showToast(e.message, 'error'); }
    document.getElementById('modal-save-btn').onclick = saveModal;
  };
  document.getElementById('modal-overlay').classList.add('open');
}

function resetUserPassword(userId) {
  document.getElementById('modal-title').textContent = '🔑 Reset Password';
  document.getElementById('modal-save-btn').style.display = '';
  document.getElementById('modal-body').innerHTML = `
    <div class="form-grid">
      <div class="form-group full">
        <label>New Password</label>
        <input type="password" id="field_new_pwd" placeholder="Minimum 8 characters">
      </div>
    </div>
  `;
  document.getElementById('modal-save-btn').onclick = async () => {
    const pwd = document.getElementById('field_new_pwd').value;
    if (!pwd || pwd.length < 8) { showToast('Password must be at least 8 characters', 'error'); return; }
    try {
      await admin.users.resetPassword(userId, pwd);
      showToast('Password reset!', 'success');
      closeModal();
    } catch(e) { showToast(e.message, 'error'); }
    document.getElementById('modal-save-btn').onclick = saveModal;
  };
  document.getElementById('modal-overlay').classList.add('open');
}

function openInviteModal() {
  document.getElementById('modal-title').textContent = '＋ Invite New User';
  document.getElementById('modal-save-btn').style.display = '';
  document.getElementById('modal-body').innerHTML = `
    <div class="form-grid">
      <div class="form-group full">
        <label>Email Address</label>
        <input type="email" id="field_invite_email" placeholder="user@company.com">
      </div>
      <div class="form-group">
        <label>Full Name</label>
        <input type="text" id="field_invite_name" placeholder="John Doe">
      </div>
      <div class="form-group">
        <label>Emp ID (optional)</label>
        <input type="text" id="field_invite_empid" placeholder="EMP001">
      </div>
      <div class="form-group">
        <label>Role</label>
        <select id="field_invite_role">
          <option value="employee">Employee</option>
          <option value="hr">HR</option>
          <option value="admin">Admin</option>
        </select>
      </div>
      <div class="form-group">
        <label>Initial Password</label>
        <input type="password" id="field_invite_pwd" placeholder="8+ characters">
      </div>
    </div>
    <div id="invite-error" style="display:none;background:#fee2e2;border:1px solid #fca5a5;border-radius:8px;padding:10px 14px;font-size:13px;color:#991b1b;margin-top:8px"></div>
  `;
  document.getElementById('modal-save-btn').onclick = saveInvite;
  document.getElementById('modal-overlay').classList.add('open');
}

async function saveInvite() {
  const email    = document.getElementById('field_invite_email').value.trim().toLowerCase();
  const fullName = document.getElementById('field_invite_name').value.trim();
  const empId    = document.getElementById('field_invite_empid').value.trim().toUpperCase();
  const role     = document.getElementById('field_invite_role').value;
  const password = document.getElementById('field_invite_pwd').value;
  const errEl    = document.getElementById('invite-error');

  if (errEl) errEl.style.display = 'none';

  // Client-side validation
  if (!email)          { _inviteErr(errEl, 'Email address is required'); return; }
  if (!email.includes('@')) { _inviteErr(errEl, 'Enter a valid email address'); return; }
  if (!password)       { _inviteErr(errEl, 'Password is required'); return; }
  if (password.length < 8) { _inviteErr(errEl, 'Password must be at least 8 characters'); return; }
  if (!['admin','hr','employee'].includes(role)) { _inviteErr(errEl, 'Please select a valid role'); return; }

  const saveBtn = document.getElementById('modal-save-btn');
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Creating…'; }

  try {
    await admin.users.create({ email, password, full_name: fullName || email, emp_id: empId || null, role });
    showToast(`✅ User created: ${email}`, 'success');
    closeModal();
    document.getElementById('modal-save-btn').onclick = saveModal;
    setTimeout(() => loadUsers('all'), 800);
  } catch(e) {
    const msg = e.message || 'User creation failed';
    if (e.isNetworkError) {
      // Network-level failure: DB write may have already succeeded
      showToast('⚠️ Network error after save. Check user list — user may already be created.', 'warn');
      closeModal();
      setTimeout(() => loadUsers('all'), 1500);
      return;
    }
    // Friendly error messages for common Supabase errors
    const friendlyMsg = msg.includes('User not allowed') || msg.includes('not allowed')
      ? 'User creation failed: Email signups may be disabled in Supabase, or this email is blocked. Please check Supabase Auth settings.'
      : msg.includes('already registered') || msg.includes('already exists')
      ? 'This email address is already registered.'
      : msg.includes('Invalid role')
      ? 'Please select a valid role (Admin / HR / Employee)'
      : msg;
    _inviteErr(errEl, friendlyMsg);
  } finally {
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save'; }
  }
}

function _inviteErr(errEl, msg) {
  if (errEl) { errEl.textContent = msg; errEl.style.display = 'block'; }
  else        showToast(msg, 'error');
}

// ─── TOAST ────────────────────────────────────────────────────────────────────
function showToast(msg, type = 'success') {
  const t = document.getElementById('toast');
  t.className = `show ${type}`;
  const icon = type === 'success' ? '✅ ' : type === 'info' ? 'ℹ️ ' : type === 'warn' ? '⚠️ ' : '❌ ';
  t.textContent = icon + msg;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.classList.remove('show'); }, 3500);
}

// ─── EXPOSE TO HTML ───────────────────────────────────────────────────────────
window.doLogin           = doLogin;
window.doLogout          = doLogout;
window.navigate          = _origNavigate; // will be overridden below
window.onSearch          = onSearch;
window.onEmpFilter       = onEmpFilter;
window.changePage        = changePage;
window.refreshTable      = refreshTable;
window.openInsertModal   = openInsertModal;
window.openEditModal     = openEditModal;
window.closeModal        = closeModal;
window.saveModal         = saveModal;
window.saveEmployeeModal = saveEmployeeModal;
window.empRecalcGmcDates = empRecalcGmcDates;
window.empValidateEmail  = empValidateEmail;
window.deleteRow         = deleteRow;
window.openBulkUpload    = openBulkUpload;
window.downloadBulkTemplate = downloadBulkTemplate;
window.handleBulkUpload  = handleBulkUpload;
window.exportExcelTable  = exportExcelTable;
window.exportPDFTable    = exportPDFTable;
window.exportAllTable    = exportAllTable;
window.filterViewsByCategory = filterViewsByCategory;
window.selectView        = selectView;
window.onViewSearch      = onViewSearch;
window.changeViewPage    = changeViewPage;
window.refreshCurrentView = refreshCurrentView;
window.closeViewPanel    = closeViewPanel;
window.exportViewExcel   = exportViewExcel;
window.exportViewPDF     = exportViewPDF;
window.loadEmpFullView   = loadEmpFullView;
window.exportEmpFullExcel = exportEmpFullExcel;
window.exportEmpFullPDF  = exportEmpFullPDF;
window.filterUsers       = filterUsers;
window.changeUserRole    = changeUserRole;
window.toggleUserActive  = toggleUserActive;
window.editUserEmpId     = editUserEmpId;
window.resetUserPassword = resetUserPassword;
window.openInviteModal   = openInviteModal;
window.saveInvite        = saveInvite;
window.openNewConcernModal = openNewConcernModal;
window.submitConcern     = submitConcern;
window.openRespondModal  = openRespondModal;
window.submitResponse    = submitResponse;
window.exportConcernsExcel = exportConcernsExcel;
window.exportConcernsPDF   = exportConcernsPDF;
window.loadTableData     = loadTableData;
window.loadEmpFullView   = loadEmpFullView;
window.viewState         = viewState;
window.fetchViewData     = fetchViewData;

// ═══════════════════════════════════════════════════════════════════════════════
// ─── GMC ENROLLMENT WIZARD (Employee) ─────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

let enrollState = {
  step: 1,
  emp: null,
  rateCards: [],
  existingEnrollment: null,
  mobile: '', email: '',
  selectedSI: 0,
  dependents: [],   // [{id, relationship, name, dob, gender}]
  summary: null,
  termsAccepted: false,
  finalAccepted: false,
  // Pre-calculated total CTC GMC from vw_employee_ctc_gmc_total (server-supplied).
  // null = no view row → fall back to proration formula in ctcGmcAvailable().
  ctcGmcTotalFromView: null,
  // gmc_inclusion_date from employees table (null → fall back to date_of_joining).
  // This is the premium proration start date for all members.
  gmcInclusionDate: null,
};

// ✅ FIX: Expose enrollState to window so inline onclick handlers in injected HTML
// can access it. main.js is a <script type="module"> — module-scoped vars are
// invisible to inline event attributes which run in global (window) scope.
window.enrollState = enrollState;

const POLICY_END_DATE = new Date('2027-07-23');
const POLICY_YEAR_START = new Date('2026-07-24'); // For coverage days normalisation

// Unit-aware CTC GMC end date: UNIT -3 FY ends 30 Jun, all others 31 Jul
function getCTCGmcEndDate(unit) {
  return (unit === 'UNIT -3') ? new Date('2027-06-30') : new Date('2027-07-31');
}

function enrollFmt(v) {
  return '₹' + Math.round(v).toLocaleString('en-IN');
}


function completedAge(dobStr, refDateStr) {
  const dob = new Date(dobStr);
  const ref = new Date(refDateStr);
  let age = ref.getFullYear() - dob.getFullYear();
  if (ref.getMonth() < dob.getMonth() ||
     (ref.getMonth() === dob.getMonth() && ref.getDate() < dob.getDate())) age--;
  return age;
}

function effectiveStartDate(emp) {
  // Premium proration start date for INSURED COVERAGE: gmc_inclusion_date if set, else date_of_joining.
  // This is used for calculating how many days the INSURANCE PREMIUM covers.
  return enrollState.gmcInclusionDate || emp?.date_of_joining || null;
}

function coverageDays(startDateStr) {
  // Policy days: effective start date → 23 Jul 2027 (inclusive)
  const doj = new Date(startDateStr);
  const days = Math.floor((POLICY_END_DATE - doj) / 86400000) + 1;
  return Math.max(0, days);
}

function ctcGmcAvailable(ctcGmcPerMonth, unit, emp) {
  // CTC GMC total must come exclusively from vw_employee_ctc_gmc_total.
  // This fallback function is intentionally a no-op — if the view returns null,
  // the employee is not yet on GMC or the view hasn't been populated.
  // Never calculate from DOJ or any other date — return 0 to show Nil deduction.
  return 0;
}

function getInsurerPremium(rateCards, si, age) {
  // Find INSURER rate card matching sum_insured and age band
  const card = rateCards.find(rc =>
    Number(rc.sum_insured) === si &&
    age >= rc.age_band_from && age <= rc.age_band_to
  );
  return card ? Number(card.annual_premium) : 0;
}

function proratedPremium(annualPremium, dojStr) {
  const days = coverageDays(dojStr);
  return Math.round((annualPremium / 365) * days);
}

function calcPremiumSummary() {
  const emp = enrollState.emp;
  const si  = enrollState.selectedSI;
  const doj = effectiveStartDate(emp);   // gmc_inclusion_date ?? date_of_joining
  const rc  = enrollState.rateCards;

  // Self
  const selfAge = completedAge(emp.date_of_birth, doj);
  const selfAnnual = getInsurerPremium(rc, si, selfAge);
  const selfProrated = proratedPremium(selfAnnual, doj);

  const memberRows = [{
    name: emp.emp_name, relationship: 'Self',
    age: selfAge, annual_premium: selfAnnual,
    coverage_days: coverageDays(doj), prorated_premium: selfProrated,
    sum_insured: si,
  }];

  enrollState.dependents.forEach(dep => {
    if (!dep.name || !dep.dob) return;
    const age = completedAge(dep.dob, doj);
    const annual = getInsurerPremium(rc, si, age);
    const prorated = proratedPremium(annual, doj);
    memberRows.push({
      name: dep.name, relationship: dep.relationship,
      age, annual_premium: annual,
      coverage_days: coverageDays(doj), prorated_premium: prorated,
      sum_insured: si,
    });
  });

  const totalPremium = memberRows.reduce((s, r) => s + r.prorated_premium, 0);
  // Use view total when available; fall back to proration formula otherwise.
  const totalCtc     = (enrollState.ctcGmcTotalFromView != null)
    ? enrollState.ctcGmcTotalFromView
    : ctcGmcAvailable(Number(emp.ctc_gmc_per_month), emp.unit, emp);
  const deduction    = Math.max(0, totalPremium - totalCtc);
  const refund       = Math.max(0, totalCtc - totalPremium);

  enrollState.summary = { totalPremium, totalCtc, deduction, refund, memberRows };
  return enrollState.summary;
}

async function renderEnrollmentForm() {
  const c = document.getElementById('content');
  c.innerHTML = `<div class="loading"><div class="spinner"></div> Loading enrollment data…</div>`;

  try {
    const data = await enrollment.getData();
    enrollState.emp = data.employee;
    enrollState.rateCards = data.rate_cards || [];
    enrollState.existingEnrollment = data.enrollment;
    // Use pre-calculated total from vw_employee_ctc_gmc_total if the view has a row
    // for this employee; null means no row → proration formula is used instead.
    enrollState.ctcGmcTotalFromView = (data.ctc_gmc_total_from_view != null)
      ? Number(data.ctc_gmc_total_from_view) : null;
    // Use gmc_inclusion_date from employees table as premium start date if available.
    enrollState.gmcInclusionDate = data.employee?.gmc_inclusion_date || null;

    // ✅ FIX #2: POPULATE EXISTING DEPENDENTS FROM API RESPONSE
    // The backend now returns existing_dependents from employee_gmc_enrollment_insured table
    if (data.existing_dependents && Array.isArray(data.existing_dependents)) {
      // FIX: Filter out 'Self' — Self is always added from emp record in buildEnrollmentPayload.
      // Without this filter, when the employee saves/submits and then returns (e.g. after a
      // correction request), the Self row saved in employee_gmc_enrollment_insured gets loaded
      // back into enrollState.dependents, causing Self to appear duplicated in the dependents
      // table and also double-counted in the premium calculation.
      enrollState.dependents = data.existing_dependents
        .filter(dep => dep.relationship !== 'Self')
        .map(dep => ({
          name: dep.insured_name,
          relationship: dep.relationship,
          dob: dep.date_of_birth,
          gender: dep.gender,
          sumInsured: dep.sum_insured,
        }));
    } else {
      enrollState.dependents = [];
    }

    // ✅ FIX: Guard null emp — happens for new employees whose draft wasn't persisted
    // or whose HR profile hasn't been set up yet. Show actionable message instead of
    // crashing with "Cannot read properties of null (reading 'emp_id')" on Step 2.
    if (!enrollState.emp) {
      c.innerHTML = `
        <div class="page-header">
          <div>
            <div class="page-title">🏥 GMC Enrollment 2025–26</div>
            <div class="page-sub">Group Medical Insurance · Magma General Insurance</div>
          </div>
        </div>
        <div style="background:white;border:1.5px solid #fcd34d;border-radius:16px;padding:40px;text-align:center;max-width:580px;margin:0 auto;box-shadow:var(--shadow)">
          <div style="font-size:48px;margin-bottom:16px">⚠️</div>
          <div style="font-size:20px;font-weight:800;color:#0f172a;margin-bottom:12px">Employee Profile Not Loaded</div>
          <p style="font-size:14px;color:var(--text2);line-height:1.7;margin-bottom:20px">
            Your account is active, but your employee profile data could not be fetched.<br><br>
            This usually means one of the following:
          </p>
          <div style="text-align:left;background:var(--surface2);border-radius:10px;padding:16px 20px;margin-bottom:24px;font-size:13px;color:var(--text2);line-height:2">
            • Your employee record hasn't been added to the system by HR yet<br>
            • Your Employee ID is not linked to a profile in the database<br>
            • The enrollment draft from your signup wasn't saved correctly
          </div>
          <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap">
            <button class="btn btn-primary" onclick="renderEnrollmentForm()">🔄 Try Again</button>
            <button class="btn btn-secondary" onclick="navigate('concerns')">📝 Raise a Concern to HR</button>
          </div>
          <p style="font-size:12px;color:var(--text3);margin-top:16px">
            Contact: Dr. Naveen – 99430 12226 &nbsp;|&nbsp; Mr. Ramakrishna R – 99167 66650
          </p>
        </div>
      `;
      return;
    }

    // ✅ FIX: Validate critical fields needed for premium calculation.
    // New employees who filled in DOJ/DOB at signup should have these, but guard anyway.
    const missingFields = [];
    if (!enrollState.emp.date_of_joining) missingFields.push('Date of Joining');
    if (!enrollState.emp.date_of_birth)   missingFields.push('Date of Birth');
    if (!enrollState.emp.emp_name)        missingFields.push('Employee Name');

    if (missingFields.length > 0) {
      c.innerHTML = `
        <div class="page-header">
          <div>
            <div class="page-title">🏥 GMC Enrollment 2025–26</div>
            <div class="page-sub">Group Medical Insurance · Magma General Insurance</div>
          </div>
        </div>
        <div style="background:white;border:1.5px solid #fca5a5;border-radius:16px;padding:40px;text-align:center;max-width:580px;margin:0 auto;box-shadow:var(--shadow)">
          <div style="font-size:48px;margin-bottom:16px">📋</div>
          <div style="font-size:20px;font-weight:800;color:#0f172a;margin-bottom:12px">Incomplete Employee Profile</div>
          <p style="font-size:14px;color:var(--text2);line-height:1.7;margin-bottom:16px">
            Your profile is missing the following fields required for GMC enrollment:
          </p>
          <div style="background:#fee2e2;border-radius:10px;padding:14px 20px;margin-bottom:24px;font-size:13px;font-weight:600;color:#991b1b">
            ${missingFields.map(f => `• ${f}`).join('<br>')}
          </div>
          <p style="font-size:13px;color:var(--text2);margin-bottom:20px">
            Please contact HR and ask them to update your employee record with these details, then return to complete your enrollment.
          </p>
          <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap">
            <button class="btn btn-primary" onclick="renderEnrollmentForm()">🔄 Try Again</button>
            <button class="btn btn-secondary" onclick="navigate('concerns')">📝 Raise a Concern to HR</button>
          </div>
        </div>
      `;
      return;
    }

    // If approved or submitted — show locked view
    if (['APPROVED','SUBMITTED'].includes(data.enrollment?.enrollment_status)) {
      renderEnrollmentLocked(data.enrollment);
      return;
    }

    // Pre-fill mobile/email: employees table is primary source (after migration)
    const empMobile = data.employee?.mobile_number || '';
    const empEmail  = data.employee?.email_id || data.profile?.email || '';
    if (data.enrollment) {
      enrollState.mobile = data.enrollment.mobile_number || empMobile || '';
      enrollState.email  = data.enrollment.email_id || empEmail || '';
      enrollState.selectedSI = Number(data.enrollment.selected_sum_insured) || 0;
      enrollState.termsAccepted = data.enrollment.terms_accepted || false;
    } else {
      // No draft yet — pre-fill from employees table
      enrollState.mobile = empMobile;
      enrollState.email  = empEmail;
    }

    renderEnrollStep(1);
  } catch(e) {
    c.innerHTML = `<div class="empty-state"><div class="icon">⚠️</div>${e.message}</div>`;
  }
}

function renderEnrollmentLocked(enrollment) {
  const c = document.getElementById('content');
  const statusColor = {APPROVED:'badge-green',SUBMITTED:'badge-blue',REJECTED:'badge-red',DRAFT:'badge-amber',CORRECTION_REQUIRED:'badge-amber'}[enrollment.enrollment_status] || 'badge-blue';
  c.innerHTML = `
    <div class="page-header">
      <div><div class="page-title">🏥 GMC Enrollment 2025–26</div><div class="page-sub">Group Medical Insurance · Magma General Insurance</div></div>
      <span class="badge ${statusColor}">${enrollment.enrollment_status}</span>
    </div>
    <div style="background:white;border-radius:16px;border:2px solid #a7f3d0;padding:32px;text-align:center;box-shadow:var(--shadow)">
      <div style="font-size:48px;margin-bottom:12px">${enrollment.enrollment_status === 'APPROVED' ? '✅' : '🔒'}</div>
      <div style="font-size:22px;font-weight:800;color:#0f172a;margin-bottom:8px">${enrollment.enrollment_status === 'APPROVED' ? 'Enrollment Approved & Locked' : 'Enrollment Submitted — Pending HR Review'}</div>
      <div style="font-size:14px;color:var(--text3);max-width:520px;margin:0 auto 20px">
        ${enrollment.enrollment_status === 'APPROVED'
          ? 'Your GMC enrollment has been <strong>approved</strong> by HR/Admin. The form is locked. Your coverage is active.'
          : 'Your enrollment has been <strong>successfully submitted</strong> and is locked pending HR/Admin review. You will be notified once approved.'}
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:12px 16px;background:var(--bg);padding:16px 24px;border-radius:12px;font-size:14px">
        <span>Sum Insured: <strong>${enrollFmt(Number(enrollment.selected_sum_insured))}</strong></span>
        <span>·</span>
        <span>Submitted: <strong>${fmtDate(enrollment.submitted_at) || '—'}</strong></span>
        <span>·</span>
        <span>Status: <span class="badge ${statusColor}">${enrollment.enrollment_status}</span></span>
      </div>
    </div>
  `;
}

function enrollStepBar(activeStep) {
  const steps = ['Policy T&C', 'Your Details', 'Dependents & Premium', 'Submit'];
  return `
    <div style="display:flex;flex-wrap:wrap;gap:0;background:white;border:1px solid var(--border);border-radius:12px;padding:5px;margin-bottom:24px;box-shadow:var(--shadow-sm)">
      ${steps.map((lbl, i) => {
        const n = i + 1;
        const isDone = n < activeStep;
        const isActive = n === activeStep;
        return `
          <div style="flex:1;min-width:70px;display:flex;flex-direction:column;align-items:center;padding:10px 6px;border-radius:8px;${isActive?'background:#dbeafe;':''}${isDone?'background:#d1fae5;':''}">
            <div style="width:26px;height:26px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;margin-bottom:4px;
              ${isActive?'background:#1d4ed8;color:white;':''}${isDone?'background:#059669;color:white;':'border:2px solid #cbd5e1;color:#94a3b8;'}">
              ${isDone ? '✓' : n}
            </div>
            <div style="font-size:11px;font-weight:600;${isActive?'color:#1d4ed8;':''}${isDone?'color:#059669;':'color:#94a3b8;'}">${lbl}</div>
          </div>`;
      }).join('')}
    </div>`;
}

function renderEnrollStep(step) {
  enrollState.step = step;
  const c = document.getElementById('content');
  const emp = enrollState.emp;

  // ✅ FIX: Guard — emp must be loaded before we can render any step past Step 1.
  // If somehow null here, reload the form (shows the proper error message).
  if (!emp && step > 1) {
    renderEnrollmentForm();
    return;
  }

  // Status banner for submitted/rejected
  let statusBanner = '';
  const ex = enrollState.existingEnrollment;
  if (ex) {
    const statusMap = {
      SUBMITTED: { cls: 'info', icon: '⏳', msg: `Your enrollment has been <strong>submitted</strong> on ${ex.submitted_at ? fmtDate(ex.submitted_at) : ''}. Awaiting HR review.` },
      REJECTED:  { cls: 'error', icon: '❌', msg: `Enrollment <strong>rejected</strong>. Reason: ${ex.admin_remarks || '—'}. Please revise and resubmit.` },
      DRAFT:     { cls: 'warn', icon: '📝', msg: ex.admin_remarks ? `<strong>Correction required:</strong> ${ex.admin_remarks}. Please update and resubmit.` : 'Draft saved. Complete all steps and submit.' },
    };
    const s = statusMap[ex.enrollment_status];
    if (s) statusBanner = `<div style="background:${s.cls==='info'?'#dbeafe':s.cls==='error'?'#fee2e2':'#fef3c7'};border:1px solid ${s.cls==='info'?'#93c5fd':s.cls==='error'?'#fca5a5':'#fcd34d'};border-radius:12px;padding:12px 16px;margin-bottom:16px;font-size:13px;color:${s.cls==='info'?'#1e40af':s.cls==='error'?'#991b1b':'#92400e'};display:flex;gap:10px"><span>${s.icon}</span><div>${s.msg}</div></div>`;
  }

  const pageHeader = `
    <div class="page-header">
      <div><div class="page-title">🏥 GMC Enrollment 2025–26</div><div class="page-sub">Group Medical Insurance · Magma General Insurance Limited</div></div>
    </div>
    ${statusBanner}
    ${enrollStepBar(step)}
  `;

  if (step === 1) c.innerHTML = pageHeader + renderEnrollStep1();
  else if (step === 2) c.innerHTML = pageHeader + renderEnrollStep2(emp);
  else if (step === 3) c.innerHTML = pageHeader + renderEnrollStep3();
  else if (step === 4) c.innerHTML = pageHeader + renderEnrollStep4(); // legacy Premium step — redirects to 3
  else if (step === 5) c.innerHTML = pageHeader + renderEnrollStep5();
}

// ── STEP 1: Terms & Conditions ────────────────────────────────────────────────
function renderEnrollStep1() {
  return `
  <div class="section-card">
    <div class="section-title">📋 Group Medical Insurance Policy — Terms & Conditions (2026–27)</div>
    <div style="border:1.5px solid var(--border);border-radius:10px;height:360px;overflow-y:auto;padding:20px 24px;font-size:13px;line-height:1.9;background:var(--surface2);margin-bottom:16px" id="tc-scroll">
      <div style="font-weight:700;font-size:14px;color:#0f172a;margin-bottom:12px">Policy Guidelines for 2025–26</div>

      <b>1. Mandatory Enrollment</b><br/>
      Insurance coverage is <strong>mandatory for employees (Self)</strong>. Coverage for family members is optional at the employee's discretion.<br/><br/>

      <b>2. Sum Insured</b><br/>
      • Minimum Family Floater sum insured: <strong>₹3,00,000</strong><br/>
      • Employees may opt for higher sum insured as per portal options.<br/>
      • <span style="background:#fef3c7;padding:1px 6px;border-radius:4px;color:#92400e;font-weight:600">⚠️ IMPORTANT: Once enhanced, sum insured cannot be reduced in future renewals — only further enhancement allowed.</span><br/><br/>

      <b>3. Premium Contribution</b><br/>
      • Additional premium (after CTC GMC adjustment) recovered via equal monthly EMIs.<br/>
      • Premium is pro-rated from Date of Joining to 23rd July 2026.<br/><br/>

      <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:12px 16px;margin:12px 0">
        <div style="font-weight:700;color:#991b1b;margin-bottom:8px">🔴 Critical Policy Conditions</div>
        <b>1. Coverage Details:</b> Self + Spouse + Up to 2 Children (unmarried/unemployed/below 25 yrs) + 2 Parents OR Parents-in-Law (one set only, max age 90 yrs). <strong>10% co-pay on parental claims.</strong><br/><br/>
        <b>2. Mid-term Additions:</b> Only for Spouse (within 30 days of marriage) or Newborn (within 30 days of birth). Existing family not currently enrolled <strong>cannot be added</strong> in future renewals. Enrolled dependents <strong>cannot be removed</strong> in future renewals.<br/><br/>
        <b>3. Maternity:</b> Capped at ₹40,000 (normal delivery) / ₹50,000 (caesarean). Applicable for first two living children only.<br/><br/>
        <b>4. GMC Applicability:</b> Strictly for <strong>ESI-exempted employees</strong> only.
      </div>

      <b>Enrollment Instructions:</b><br/>
      • <strong>Insurer:</strong> Magma General Insurance Limited<br/>
      • <strong>TPA:</strong> Medi Assist Insurance TPA Pvt. Ltd.<br/>
      • <strong>Broker:</strong> Ensign Insurance Brokers Pvt. Ltd.<br/>
      • <strong>Policy Period:</strong> Date of Joining to <strong>23rd July 2026</strong><br/><br/>

      <b>Contact for Assistance:</b><br/>
      • Dr. Naveen – naveen.paun@globalcalciumpharma.com | 99430 12226<br/>
      • Mr. Ramakrishna R – ramakrishna.r@globalcalciumpharma.com | 99167 66650<br/><br/>

      <div style="background:#dbeafe;border:1px solid #93c5fd;border-radius:8px;padding:10px 14px;font-style:italic;color:#1e40af">
        By proceeding, you confirm you have read, understood, and agree to be bound by the above policy terms.
      </div>
    </div>

    <div style="display:flex;align-items:flex-start;gap:12px;background:#f0fdf4;border:1.5px solid #a7f3d0;border-radius:10px;padding:14px 18px;cursor:pointer;margin-bottom:12px">
      <input type="checkbox" id="tc-cb" style="width:18px;height:18px;margin-top:2px;flex-shrink:0;accent-color:#059669" ${enrollState.termsAccepted?'checked':''} onchange="enrollState.termsAccepted=this.checked;document.getElementById('btn-proceed-tc').disabled=!this.checked"/>
      <label for="tc-cb" style="font-size:13px;line-height:1.6;cursor:pointer">I <strong>have read and fully understood</strong> the Group Medical Insurance Policy terms and conditions for 2026–27, including all coverage details, restrictions, and premium obligations.</label>
    </div>

    <button class="btn btn-primary" id="btn-proceed-tc" onclick="renderEnrollStep(2)" ${enrollState.termsAccepted?'':'disabled'}>
      Proceed to Enrollment Form →
    </button>
  </div>`;
}

// ── STEP 2: Employee Details + Sum Insured ────────────────────────────────────
function renderEnrollStep2(emp) {
  // Only allow 3L, 4L, 5L, 6L, 7L, 10L
  const ALLOWED_SI = [300000, 400000, 500000, 600000, 700000, 1000000];
  const allSI = [...new Set(enrollState.rateCards.map(rc => Number(rc.sum_insured)))].sort((a,b)=>a-b);
  const siSet = allSI.filter(si => ALLOWED_SI.includes(si));
  if (!siSet.length) siSet.push(...ALLOWED_SI); // fallback

  return `
  <div class="section-card">
    <div class="section-title">👤 Personal & Employment Details</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px;margin-bottom:4px">
      <div class="form-group"><label>Employee ID</label><input readonly value="${emp.emp_id}" style="background:var(--bg)"></div>
      <div class="form-group"><label>Full Name</label><input readonly value="${emp.emp_name}" style="background:var(--bg)"></div>
      <div class="form-group"><label>Date of Birth</label><input readonly value="${fmtDate(emp.date_of_birth)}" style="background:var(--bg)"></div>
      <div class="form-group"><label>Gender</label><input readonly value="${emp.gender||'—'}" style="background:var(--bg)"></div>
      <div class="form-group"><label>Department</label><input readonly value="${emp.department||'—'}" style="background:var(--bg)"></div>
      <div class="form-group"><label>Designation</label><input readonly value="${emp.designation||'—'}" style="background:var(--bg)"></div>
      <div class="form-group"><label>Date of Joining</label><input readonly value="${fmtDate(emp.date_of_joining)}" style="background:var(--bg)"></div>
      <div class="form-group"><label>Monthly CTC GMC (₹)</label><input readonly value="${Number(emp.ctc_gmc_per_month).toFixed(2)}" style="background:var(--bg)"></div>
      <div class="form-group"><label>Unit</label><input readonly value="${emp.unit||'—'}" style="background:var(--bg)"></div>
    </div>

    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px;margin-top:14px">
      <div class="form-group">
        <label>Mobile Number</label>
        ${enrollState.mobile
          ? `<input type="tel" id="enroll-mobile" value="${enrollState.mobile}" maxlength="10" readonly style="background:var(--bg);cursor:not-allowed">
             <div style="font-size:11px;color:var(--text3);margin-top:4px">🔒 From your registration. Contact HR to update.</div>`
          : `<input type="tel" id="enroll-mobile" value="" maxlength="10" placeholder="Enter 10-digit mobile number" style="border:1.5px solid #f59e0b">
             <div style="font-size:11px;color:#b45309;margin-top:4px">⚠️ Not found in registration. Enter your mobile number to continue.</div>`
        }
      </div>
      <div class="form-group">
        <label>Email ID</label>
        ${enrollState.email
          ? `<input type="email" id="enroll-email" value="${enrollState.email}" readonly style="background:var(--bg);cursor:not-allowed">
             <div style="font-size:11px;color:var(--text3);margin-top:4px">🔒 From your registration. Contact HR to update.</div>`
          : `<input type="email" id="enroll-email" value="" placeholder="Enter your email address" style="border:1.5px solid #f59e0b">
             <div style="font-size:11px;color:#b45309;margin-top:4px">⚠️ Not found in registration. Enter your email to continue.</div>`
        }
      </div>
    </div>
  </div>

  <div class="section-card">
    <div class="section-title">🏥 Select Sum Insured (Family Floater)</div>
    <div style="font-size:13px;color:var(--text3);margin-bottom:16px">Minimum ₹3,00,000. <span style="color:var(--danger);font-weight:600">⚠️ Once selected and approved, sum insured cannot be reduced in future renewals.</span></div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:16px">
      ${siSet.map(si => {
        const isSel = enrollState.selectedSI===si;
        const label = si===300000?'Minimum (Standard)':si===400000?'Enhanced':si===500000?'Premium':si===600000?'Elite':si===700000?'Super Elite':'Maximum';
        return `
        <div onclick="enrollState.selectedSI=${si};document.querySelectorAll('.si-card').forEach(el=>{el.classList.remove('si-selected');el.style.border='2px solid var(--border)';el.style.background='white';el.querySelector('.si-check').style.display='none'});this.classList.add('si-selected');this.style.border='2px solid #1d4ed8';this.style.background='#dbeafe';this.querySelector('.si-check').style.display='block'"
          class="si-card${isSel?' si-selected':''}"
          style="border:2px solid ${isSel?'#1d4ed8':'var(--border)'};background:${isSel?'#dbeafe':'white'};border-radius:12px;padding:16px;text-align:center;cursor:pointer;transition:.2s;position:relative">
          <div class="si-check" style="position:absolute;top:6px;right:8px;color:#1d4ed8;font-weight:800;font-size:14px;display:${isSel?'block':'none'}">✓</div>
          <div style="font-size:18px;font-weight:800;color:#0f172a">${enrollFmt(si)}</div>
          <div style="font-size:11px;color:var(--text3);margin-top:4px">${label}</div>
        </div>`;
      }).join('')}
    </div>

    <div style="display:flex;gap:10px;margin-top:8px">
      <button class="btn btn-secondary" onclick="renderEnrollStep(1)">← Back</button>
      <button class="btn btn-primary" onclick="enrollStep2Next()">Next: Add Dependents →</button>
    </div>
  </div>`;
}

function enrollStep2Next() {
  const mobile = document.getElementById('enroll-mobile')?.value?.trim() || enrollState.mobile;
  const email  = document.getElementById('enroll-email')?.value?.trim()  || enrollState.email;
  if (!/^\d{10}$/.test(mobile)) { showToast('Please enter a valid 10-digit mobile number', 'error'); return; }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { showToast('Please enter a valid email address', 'error'); return; }
  if (!enrollState.selectedSI) { showToast('Please select a Sum Insured', 'error'); return; }
  enrollState.mobile = mobile;
  enrollState.email  = email;
  renderEnrollStep(3);
}

// ── STEP 3+4 COMBINED: Dependents & Premium ─────────────────────────────────
function renderEnrollStep3() {
  const emp = enrollState.emp;
  const deps = enrollState.dependents;

  const hasSpouse   = deps.some(d => d.relationship === 'Spouse');
  const childCount  = deps.filter(d => ['Son','Daughter'].includes(d.relationship)).length;
  const hasParents  = deps.some(d => ['Father','Mother'].includes(d.relationship));
  const hasInLaws   = deps.some(d => ['Father-in-Law','Mother-in-Law'].includes(d.relationship));
  const parentCount = deps.filter(d => ['Father','Mother','Father-in-Law','Mother-in-Law'].includes(d.relationship)).length;

  const availableRels = [];
  if (!hasSpouse) availableRels.push('Spouse');
  if (childCount < 2) availableRels.push('Son', 'Daughter');
  if (parentCount < 2 && !hasInLaws) availableRels.push('Father', 'Mother');
  if (parentCount < 2 && !hasParents) availableRels.push('Father-in-Law', 'Mother-in-Law');

  // Find the dep currently being edited (if any)
  const editingIdx = deps.findIndex(d => d._editing === true);
  const editingDep = editingIdx >= 0 ? deps[editingIdx] : null;

  // Build live premium table
  const premiumSection = renderLivePremiumTable();

  // ── Edit / Add form (only shown while a dep is open for editing) ──────────
  const editFormHtml = editingDep ? `
  <div class="section-card" data-dep-edit-form style="margin-bottom:16px;border:2px solid #93c5fd;background:#eff6ff">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
      <div class="section-title" style="color:#1d4ed8;margin-bottom:0">
        ${editingDep.name ? `✏️ Editing: ${editingDep.relationship} — ${editingDep.name}` : `➕ Adding: ${editingDep.relationship}`}
      </div>
      <div style="display:flex;gap:6px">
        <button onclick="saveDependentEdit(${editingIdx})"
          style="background:#059669;color:white;border:none;cursor:pointer;font-size:12px;font-weight:700;padding:6px 16px;border-radius:8px;${!(editingDep.name && editingDep.dob) ? 'display:none' : ''}">✓ Save & Close</button>
        <button onclick="removeDependent(${editingIdx})"
          style="background:#fee2e2;border:none;color:var(--danger);cursor:pointer;font-size:12px;font-weight:600;padding:6px 14px;border-radius:8px">✕ Cancel / Remove</button>
      </div>
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px">
      <div class="form-group">
        <label>Full Name <span style="color:var(--danger)">*</span></label>
        <input type="text" id="dep-name-input" value="${editingDep.name}" placeholder="Full name"
          oninput="enrollState.dependents[${editingIdx}].name=this.value;checkDepSaveBtn(${editingIdx})"
          onchange="refreshPremiumPreview()">
      </div>
      <div class="form-group">
        <label>Date of Birth <span style="color:var(--danger)">*</span></label>
        <input type="date" id="dep-dob-input" value="${editingDep.dob}"
          onchange="enrollState.dependents[${editingIdx}].dob=this.value;refreshPremiumPreview();checkDepSaveBtn(${editingIdx})"
          ${['Son','Daughter'].includes(editingDep.relationship)?'max="'+new Date().toISOString().slice(0,10)+'"':''} style="color-scheme:light">
      </div>
      ${(['Son','Father','Father-in-Law'].includes(editingDep.relationship) || (editingDep.relationship==='Spouse' && enrollState.emp?.gender==='Female')) ? `
      <div class="form-group"><label>Gender</label><input readonly value="Male" style="background:var(--bg)"></div>` :
      (['Daughter','Mother','Mother-in-Law'].includes(editingDep.relationship) || (editingDep.relationship==='Spouse' && enrollState.emp?.gender==='Male')) ? `
      <div class="form-group"><label>Gender</label><input readonly value="Female" style="background:var(--bg)"></div>` :
      `<div class="form-group"><label>Gender</label>
        <select onchange="enrollState.dependents[${editingIdx}].gender=this.value">
          <option value="Male" ${editingDep.gender==='Male'?'selected':''}>Male</option>
          <option value="Female" ${editingDep.gender==='Female'?'selected':''}>Female</option>
        </select></div>`}
    </div>
    ${editingDep.relationship==='Spouse' ? '<p style="font-size:11px;color:#1d4ed8;margin-top:8px">ℹ️ Spouse must be at least 18 years old on your date of joining.</p>' : ''}
    ${['Son','Daughter'].includes(editingDep.relationship) ? '<p style="font-size:11px;color:#d97706;margin-top:8px">⚠️ Child must be unmarried, unemployed and below 25 years of age on date of joining.</p>' : ''}
    ${['Father','Mother','Father-in-Law','Mother-in-Law'].includes(editingDep.relationship) ? '<p style="font-size:11px;color:var(--text3);margin-top:8px">ℹ️ Parents/In-laws max age 90 years. 10% co-pay applies on all parental claims.</p>' : ''}
  </div>` : '';

  // ── Add bar — always shown when no edit is open AND slots remain ───────────
  const addBarHtml = !editingDep ? (
    availableRels.length > 0 ? `
  <div class="section-card" style="margin-bottom:16px">
    <div class="section-title">👨‍👩‍👧 Add Dependents</div>
    <div style="background:#fef3c7;border:1px solid #fcd34d;border-radius:10px;padding:10px 14px;font-size:12px;color:#92400e;margin-bottom:14px">
      📌 Coverage: Self + <strong>1 Spouse</strong> + <strong>Up to 2 Children</strong> (unmarried/unemployed, below 25 yrs) + <strong>2 Parents OR 2 Parents-in-Law</strong> (one set, max age 90). 10% co-pay on parental claims.
    </div>
    <div style="display:flex;align-items:center;gap:10px">
      <select id="new-dep-rel" style="flex:1;border:1.5px solid var(--border);border-radius:9px;padding:9px 12px;font-size:13px;font-family:inherit;background:var(--surface2)">
        <option value="">— Select relationship to add —</option>
        ${availableRels.map(r => `<option value="${r}">${r}</option>`).join('')}
      </select>
      <button class="btn btn-primary" onclick="addDependent()">＋ Add Dependent</button>
    </div>
  </div>` : `
  <div class="section-card" style="margin-bottom:16px">
    <div class="section-title">👨‍👩‍👧 Add Dependents</div>
    <div style="font-size:13px;color:#059669;padding:10px;background:#f0fdf4;border-radius:8px;border:1px solid #a7f3d0">✅ Maximum dependents added — edit or remove from the table below</div>
  </div>`
  ) : '';

  return `
  ${editFormHtml}
  ${addBarHtml}

  <!-- Live Premium Table (always visible, contains member list + edit/delete) -->
  ${premiumSection}

  <div style="display:flex;gap:10px;margin-top:8px">
    <button class="btn btn-secondary" onclick="renderEnrollStep(2)">← Back</button>
    <button class="btn btn-primary" onclick="enrollStep3Next()">Review & Submit →</button>
  </div>`;
}

// Save a dependent edit and return to the normal view (add bar visible again)
function saveDependentEdit(idx) {
  const dep = enrollState.dependents[idx];
  if (!dep) return;
  if (!dep.name?.trim()) { showToast('Please enter the full name', 'error'); return; }
  if (!dep.dob) { showToast('Please enter the date of birth', 'error'); return; }
  dep._editing = false;
  renderEnrollStep(3);
}
window.saveDependentEdit = saveDependentEdit;

// Show/hide the Save & Close button dynamically as the user types name/dob
function checkDepSaveBtn(idx) {
  const dep = enrollState.dependents[idx];
  if (!dep) return;
  const btn = document.querySelector('[onclick="saveDependentEdit(' + idx + ')"]');
  if (!btn) return;
  if (dep.name?.trim() && dep.dob) {
    btn.style.display = '';
  } else {
    btn.style.display = 'none';
  }
}
window.checkDepSaveBtn = checkDepSaveBtn;

function renderLivePremiumTable() {
  if (!enrollState.selectedSI || !enrollState.emp) return '';
  const emp = enrollState.emp;
  const si  = enrollState.selectedSI;
  const doj = effectiveStartDate(emp);   // gmc_inclusion_date ?? date_of_joining
  const rc  = enrollState.rateCards;

  // Only include dependents with complete data
  const completeDeps = enrollState.dependents.filter(d => d.name && d.dob);

  const allMembers = [
    { name: emp.emp_name, relationship: 'Self', dob: emp.date_of_birth, isSelf: true },
    ...completeDeps.map((d, i) => ({ name: d.name, relationship: d.relationship, dob: d.dob, depIdx: i }))
  ];

  const rows = allMembers.map(m => {
    const age = completedAge(m.dob, doj);
    const annual = getInsurerPremium(rc, si, age);
    const prorated = proratedPremium(annual, doj);
    return { ...m, age, annual, prorated, days: coverageDays(doj) };
  });

  const totalPremium = rows.reduce((s, r) => s + r.prorated, 0);
  // Use view total when available; fall back to JS fallback otherwise.
  // Fallback uses gmc_effective_date (via emp object) — NOT doj or gmc_inclusion_date.
  const totalCtc = (enrollState.ctcGmcTotalFromView != null)
    ? enrollState.ctcGmcTotalFromView
    : ctcGmcAvailable(emp.ctc_gmc_per_month || 0, emp.unit, emp);
  const deduction = Math.max(0, totalPremium - totalCtc);
  const refund    = Math.max(0, totalCtc - totalPremium);

  const memberCount = rows.length;

  return `
  <div class="section-card" style="border:2px solid #e0e7ff" data-premium-preview>
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
      <div class="section-title" style="color:#1d4ed8;margin-bottom:0">💰 Premium Preview</div>
      <span style="font-size:12px;background:#dbeafe;color:#1d4ed8;font-weight:700;padding:3px 10px;border-radius:20px">${memberCount} member${memberCount!==1?'s':''} · Sum Insured: ${enrollFmt(si)}</span>
    </div>
    <div style="font-size:12px;color:var(--text3);margin-bottom:12px">Updates automatically as you add/edit/remove dependents</div>
    <div style="overflow-x:auto;margin-bottom:16px">
      <table class="data-table" style="font-size:13px">
        <thead>
          <tr>
            <th>Member</th><th>Relationship</th><th>Age on DOJ</th>
            <th>Annual Premium</th><th>Coverage Days</th><th>Pro-rated Premium</th>
            <th style="width:100px;text-align:center">Actions</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((r) => `<tr style="background:${r.isSelf?'#f0f9ff':'white'}">
            <td><strong>${r.name||'—'}</strong></td>
            <td><span style="font-size:11px;background:${r.isSelf?'#dbeafe':'#f1f5f9'};padding:2px 8px;border-radius:20px;font-weight:700">${r.relationship}</span></td>
            <td>${r.age} yrs</td>
            <td>${enrollFmt(r.annual)}</td>
            <td>${r.days}</td>
            <td style="font-weight:700">${enrollFmt(r.prorated)}</td>
            <td style="text-align:center">
              ${r.isSelf
                ? `<span style="color:#94a3b8;font-size:11px">Mandatory</span>`
                : `<div style="display:flex;gap:4px;justify-content:center">
                    <button onclick="editDepFromTable(${r.depIdx})"
                      style="background:#dbeafe;border:none;color:#1d4ed8;cursor:pointer;font-size:11px;font-weight:600;padding:4px 8px;border-radius:6px" title="Edit">✏️ Edit</button>
                    <button onclick="removeDependent(${r.depIdx})"
                      style="background:#fee2e2;border:none;color:var(--danger);cursor:pointer;font-size:11px;font-weight:600;padding:4px 8px;border-radius:6px" title="Remove">✕</button>
                  </div>`
              }
            </td>
          </tr>`).join('')}
        </tbody>
        <tfoot>
          <tr style="background:#f8faff;font-weight:700;border-top:2px solid #e0e7ff">
            <td colspan="5" style="text-align:right;color:var(--text2);font-size:12px">Total Pro-rated Premium</td>
            <td style="font-size:15px;color:#1d4ed8">${enrollFmt(totalPremium)}</td>
            <td></td>
          </tr>
        </tfoot>
      </table>
    </div>

    <!-- Summary cards -->
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px">
      <div style="background:#1e3a8a;color:white;border-radius:10px;padding:12px;text-align:center">
        <div style="font-size:10px;opacity:.75;text-transform:uppercase;letter-spacing:.05em">Total Premium</div>
        <div style="font-size:18px;font-weight:800;margin-top:4px">${enrollFmt(totalPremium)}</div>
      </div>
      <div style="background:#065f46;color:white;border-radius:10px;padding:12px;text-align:center">
        <div style="font-size:10px;opacity:.75;text-transform:uppercase;letter-spacing:.05em">CTC GMC Available</div>
        <div style="font-size:18px;font-weight:800;margin-top:4px">${enrollFmt(totalCtc)}</div>
      </div>
      <div style="background:${deduction>0?'rgba(220,38,38,1)':'#059669'};color:white;border-radius:10px;padding:12px;text-align:center">
        <div style="font-size:10px;opacity:.75;text-transform:uppercase;letter-spacing:.05em">${deduction>0?'Salary Deduction':'GMC Refund'}</div>
        <div style="font-size:18px;font-weight:800;margin-top:4px">${deduction>0 ? enrollFmt(deduction) : refund>0 ? enrollFmt(refund) : 'Nil'}</div>
      </div>
      <div style="background:#1e40af;color:white;border-radius:10px;padding:12px;text-align:center">
        <div style="font-size:10px;opacity:.75;text-transform:uppercase;letter-spacing:.05em">Net Position</div>
        <div style="font-size:14px;font-weight:700;margin-top:6px">${deduction>0?'⚠️ Salary Deductable':refund>0?'✅ CTC GMC Refund':'✅ Nil'}</div>
      </div>
    </div>
  </div>`;
}

function editDepFromTable(idx) {
  // Close any other open edits first
  enrollState.dependents.forEach((d, i) => { if (i !== idx) d._editing = false; });
  enrollState.dependents[idx]._editing = true;
  renderEnrollStep(3);
  // Scroll to the edit form at the top of the page
  setTimeout(() => {
    const editForm = document.querySelector('[data-dep-edit-form]');
    if (editForm) editForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
    // Focus the name field if empty
    const nameInput = document.getElementById('dep-name-input');
    if (nameInput && !nameInput.value) nameInput.focus();
  }, 50);
}
window.editDepFromTable = editDepFromTable;

let _premiumRefreshTimer = null;
function refreshPremiumPreview() {
  clearTimeout(_premiumRefreshTimer);
  _premiumRefreshTimer = setTimeout(() => {
    const previewEl = document.querySelector('[data-premium-preview]');
    if (previewEl) {
      const newHtml = renderLivePremiumTable();
      if (newHtml) previewEl.outerHTML = newHtml;
    } else {
      renderEnrollStep(3);
    }
  }, 600);
}

function addDependent() {
  const rel = document.getElementById('new-dep-rel')?.value;
  if (!rel) { showToast('Please select a relationship', 'error'); return; }
  const empGender = enrollState.emp?.gender || 'Male';
  const defaultGender = ['Father','Father-in-Law','Son'].includes(rel) ? 'Male' :
    ['Mother','Mother-in-Law','Daughter'].includes(rel) ? 'Female' :
    rel === 'Spouse' ? (empGender === 'Male' ? 'Female' : 'Male') : 'Female';
  enrollState.dependents.push({ id: Date.now(), relationship: rel, name: '', dob: '', gender: defaultGender, _editing: true });
  renderEnrollStep(3);
  // Scroll to edit form and focus name field
  setTimeout(() => {
    const editForm = document.querySelector('[data-dep-edit-form]');
    if (editForm) editForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
    const nameInput = document.getElementById('dep-name-input');
    if (nameInput) nameInput.focus();
  }, 50);
}

function removeDependent(idx) {
  enrollState.dependents.splice(idx, 1);
  renderEnrollStep(3);
}

function enrollStep3Next() {
  const emp = enrollState.emp;
  const doj = effectiveStartDate(emp);   // gmc_inclusion_date ?? date_of_joining

  for (let i = 0; i < enrollState.dependents.length; i++) {
    const dep = enrollState.dependents[i];
    if (!dep.name?.trim()) { showToast(`Please enter name for ${dep.relationship}`, 'error'); return; }
    if (!dep.dob) { showToast(`Please enter date of birth for ${dep.relationship}`, 'error'); return; }
    const age = completedAge(dep.dob, doj);
    if (dep.relationship === 'Spouse') {
      if (age < 18) { showToast(`Spouse must be at least 18 years old on GMC Inclusion Date (${doj})`, 'error'); return; }
    }
    if (['Son','Daughter'].includes(dep.relationship)) {
      if (age >= 25) { showToast(`${dep.relationship} must be below 25 years on GMC Inclusion Date (${doj})`, 'error'); return; }
    }
    if (['Father','Mother','Father-in-Law','Mother-in-Law'].includes(dep.relationship)) {
      if (age > 90) { showToast(`${dep.relationship}'s age cannot exceed 90 years`, 'error'); return; }
    }
  }

  calcPremiumSummary();
  renderEnrollStep(5);
}

// ── STEP 4: Premium Calculation (legacy — kept for Back button from Submit) ───
function renderEnrollStep4() {
  const s = enrollState.summary;
  const emp = enrollState.emp;

  if (!s) { calcPremiumSummary(); return renderEnrollStep(4); }

  return `
  <div class="section-card">
    <div class="section-title">💰 Premium Calculation</div>
    <div style="font-size:13px;color:var(--text3);margin-bottom:16px">
      Based on <strong>Magma General Insurance INSURER rate card</strong>. Premium is pro-rated from ${enrollState.gmcInclusionDate ? 'GMC Inclusion Date' : 'Date of Joining'} (${fmtDate(effectiveStartDate(emp))}) to 23 Jul 2026.
      CTC GMC is calculated from Date of Joining to 31 Jul 2027.
    </div>

    <div style="overflow-x:auto;margin-bottom:20px">
      <table class="data-table">
        <thead><tr><th>Member</th><th>Relationship</th><th>Age on DOJ</th><th>Sum Insured</th><th>Annual Premium</th><th>Coverage Days</th><th>Pro-rated Premium</th></tr></thead>
        <tbody>
          ${s.memberRows.map(r => `<tr>
            <td>${r.name}</td><td>${r.relationship}</td><td>${r.age} yrs</td>
            <td>${enrollFmt(r.sum_insured)}</td>
            <td>${enrollFmt(r.annual_premium)}</td>
            <td>${r.coverage_days}</td>
            <td style="font-weight:700">${enrollFmt(r.prorated_premium)}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>

    <!-- Premium Summary Box -->
    <div style="background:linear-gradient(135deg,#1e3a8a,#1d4ed8);border-radius:14px;padding:24px;color:white;margin-bottom:16px">
      <div style="font-size:15px;font-weight:700;margin-bottom:16px;opacity:.9">📊 Your Premium Summary</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px">
        <div style="background:rgba(255,255,255,.1);border-radius:10px;padding:14px">
          <div style="font-size:11px;opacity:.75;text-transform:uppercase;letter-spacing:.06em">Total Insurer Premium</div>
          <div style="font-size:22px;font-weight:800;margin-top:4px">${enrollFmt(s.totalPremium)}</div>
          <div style="font-size:11px;opacity:.6;margin-top:2px">Pro-rated to 23 Jul 2026</div>
        </div>
        <div style="background:rgba(255,255,255,.1);border-radius:10px;padding:14px">
          <div style="font-size:11px;opacity:.75;text-transform:uppercase;letter-spacing:.06em">CTC GMC Available</div>
          <div style="font-size:22px;font-weight:800;margin-top:4px">${enrollFmt(s.totalCtc)}</div>
          <div style="font-size:11px;opacity:.6;margin-top:2px">Pro-rated to 31 Jul 2027</div>
        </div>
        ${s.deduction > 0 ? `
        <div style="background:rgba(220,38,38,.25);border-radius:10px;padding:14px">
          <div style="font-size:11px;opacity:.75;text-transform:uppercase;letter-spacing:.06em">Salary Deduction (Total)</div>
          <div style="font-size:22px;font-weight:800;margin-top:4px">${enrollFmt(s.deduction)}</div>
          <div style="font-size:11px;opacity:.6;margin-top:2px">Deducted from salary in instalments</div>
        </div>` : `
        <div style="background:rgba(5,150,105,.25);border-radius:10px;padding:14px">
          <div style="font-size:11px;opacity:.75;text-transform:uppercase;letter-spacing:.06em">GMC Refund to You</div>
          <div style="font-size:22px;font-weight:800;margin-top:4px">${enrollFmt(s.refund)}</div>
          <div style="font-size:11px;opacity:.6;margin-top:2px">CTC GMC exceeds premium</div>
        </div>`}
        <div style="background:rgba(255,255,255,.07);border-radius:10px;padding:14px">
          <div style="font-size:11px;opacity:.75;text-transform:uppercase;letter-spacing:.06em">Net Position</div>
          <div style="font-size:16px;font-weight:700;margin-top:4px">${s.deduction > 0 ? '⚠️ Salary Deductable' : s.refund > 0 ? '✅ CTC GMC Refund' : '✅ Nil'}</div>
        </div>
      </div>
    </div>

    <div style="background:#dbeafe;border:1px solid #93c5fd;border-radius:10px;padding:14px 18px;font-size:13px;color:#1e40af;margin-bottom:16px">
      📞 <strong>Need help?</strong> Contact Dr. Naveen (99430 12226) or Mr. Ramakrishna R (99167 66650)
    </div>

    <div style="display:flex;gap:10px">
      <button class="btn btn-secondary" onclick="renderEnrollStep(3)">← Back</button>
      <button class="btn btn-primary" onclick="renderEnrollStep(5)">Review & Submit →</button>
    </div>
  </div>`;
}

// ── STEP 5: Review & Submit ───────────────────────────────────────────────────
function renderEnrollStep5() {
  const emp = enrollState.emp;
  const s = enrollState.summary;

  return `
  <div class="section-card">
    <div class="section-title">✅ Review & Final Submission</div>

    <!-- Review details -->
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;font-size:13px;margin-bottom:16px">
      <div><span style="color:var(--text3)">Emp ID:</span> <strong>${emp.emp_id}</strong></div>
      <div><span style="color:var(--text3)">Name:</span> <strong>${emp.emp_name}</strong></div>
      <div><span style="color:var(--text3)">DOJ:</span> <strong>${fmtDate(emp.date_of_joining)}</strong></div>
      <div><span style="color:var(--text3)">Mobile:</span> <strong>${enrollState.mobile}</strong></div>
      <div><span style="color:var(--text3)">Email:</span> <strong>${enrollState.email}</strong></div>
      <div><span style="color:var(--text3)">Sum Insured:</span> <strong>${enrollFmt(enrollState.selectedSI)}</strong></div>
    </div>

    <div style="font-weight:700;font-size:13px;margin-bottom:8px">Insured Members (${1 + enrollState.dependents.length})</div>
    ${enrollState.dependents.length === 0
      ? '<p style="font-size:13px;color:var(--text3);margin-bottom:12px">No dependents added (Self only)</p>'
      : enrollState.dependents.map(d => `<div style="font-size:13px;padding:6px 0;border-bottom:1px solid var(--border);color:var(--text2)">${d.name} — <strong>${d.relationship}</strong> — DOB: ${fmtDate(d.dob)}</div>`).join('')}

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:16px 0;font-size:13px">
      <div style="background:var(--bg);border-radius:10px;padding:12px"><span style="color:var(--text3)">Total Premium:</span><br/><strong style="font-size:18px">${s ? enrollFmt(s.totalPremium) : '—'}</strong></div>
      <div style="background:var(--bg);border-radius:10px;padding:12px"><span style="color:var(--text3)">Salary Deduction:</span><br/><strong style="font-size:18px;color:${s?.deduction > 0 ? 'var(--danger)' : 'var(--hr)'}">${s ? (s.deduction > 0 ? enrollFmt(s.deduction) : 'Nil') : '—'}</strong></div>
    </div>

    <!-- Final consent -->
    <div style="display:flex;align-items:flex-start;gap:12px;background:#f0fdf4;border:1.5px solid #a7f3d0;border-radius:10px;padding:14px 18px;cursor:pointer;margin-bottom:16px" onclick="var cb=document.getElementById('final-cb');cb.checked=!cb.checked;enrollState.finalAccepted=cb.checked;document.getElementById('btn-submit-enroll').disabled=!cb.checked">
      <input type="checkbox" id="final-cb" style="width:18px;height:18px;margin-top:2px;flex-shrink:0;accent-color:#059669" onclick="event.stopPropagation()" onchange="enrollState.finalAccepted=this.checked;document.getElementById('btn-submit-enroll').disabled=!this.checked"/>
      <label for="final-cb" style="font-size:13px;line-height:1.6;cursor:pointer" onclick="event.stopPropagation()">I <strong>hereby declare</strong> that all information provided in this enrollment form is true, accurate, and complete. I consent to enroll myself and listed dependents under the Group Medical Insurance Policy 2026–27.</label>
    </div>

    <div style="display:flex;gap:10px">
      <button class="btn btn-secondary" onclick="renderEnrollStep(3)">← Back</button>
      <button class="btn btn-primary" id="btn-submit-enroll" onclick="submitEnrollment()" disabled>🚀 Submit Enrollment</button>
    </div>
  </div>`;
}

async function enrollAutoSave() {
  const payload = buildEnrollmentPayload('save');
  try {
    await enrollment.save(payload);
    showToast('Draft saved!', 'success');
  } catch(e) {
    showToast('Auto-save failed: ' + e.message, 'error');
  }
}

function buildEnrollmentPayload(action) {
  const emp = enrollState.emp;
  const s = enrollState.summary;

  const enrollmentData = {
    emp_name: emp.emp_name,
    gender: emp.gender,
    date_of_birth: emp.date_of_birth,
    department: emp.department,
    designation: emp.designation,
    date_of_joining: emp.date_of_joining,
    ctc_gmc_per_month: emp.ctc_gmc_per_month,
    gmc_inclusion_date: enrollState.gmcInclusionDate || emp.date_of_joining,
    mobile_number: enrollState.mobile,
    email_id: enrollState.email,
    selected_sum_insured: enrollState.selectedSI,
    terms_accepted: enrollState.termsAccepted,
    final_declaration_accepted: enrollState.finalAccepted,
  };

  const insured_members = [];
  const doj = effectiveStartDate(emp);   // gmc_inclusion_date ?? date_of_joining
  // Self
  insured_members.push({
    insured_name: emp.emp_name,
    relationship: 'Self',
    gender: emp.gender,
    date_of_birth: emp.date_of_birth,
    age_as_on_doj: completedAge(emp.date_of_birth, doj),
    sum_insured: enrollState.selectedSI,
    annual_premium: s?.memberRows[0]?.annual_premium || 0,
    coverage_days: coverageDays(doj),
    prorated_premium: s?.memberRows[0]?.prorated_premium || 0,
  });
  // Dependents
  enrollState.dependents.forEach((dep, idx) => {
    const row = s?.memberRows[idx+1];
    insured_members.push({
      insured_name: dep.name,
      relationship: dep.relationship,
      gender: dep.gender,
      date_of_birth: dep.dob,
      age_as_on_doj: completedAge(dep.dob, doj),
      sum_insured: enrollState.selectedSI,
      annual_premium: row?.annual_premium || 0,
      coverage_days: coverageDays(doj),
      prorated_premium: row?.prorated_premium || 0,
    });
  });

  const summary = s ? {
    total_insurer_premium: s.totalPremium,
    total_ctc_gmc_available: s.totalCtc,
    salary_deduction: s.deduction,
    gmc_refund: s.refund,
  } : null;

  return { enrollment: enrollmentData, insured_members, summary };
}

async function submitEnrollment() {
  if (!enrollState.finalAccepted) {
    showToast('Please check the final declaration box', 'error');
    return;
  }

  const btn = document.getElementById('btn-submit-enroll');
  const _resetBtn = () => {
    if (btn) { btn.disabled = false; btn.textContent = '🚀 Submit Enrollment'; }
  };

  if (btn) { btn.disabled = true; btn.textContent = '⏳ Submitting…'; }

  // Guard: if a previous click already submitted successfully (common on network retry),
  // skip re-submitting — the backend idempotency check handles this, but short-circuit here
  // to avoid a confusing error→success two-step.
  if (enrollState.existingEnrollment?.enrollment_status === 'SUBMITTED') {
    showEnrollmentSuccessModal();
    setTimeout(() => renderEnrollmentForm(), 1000);
    return;
  }

  // ── Client-side safety timeout ────────────────────────────────────────────
  // If the entire operation (including retry) takes more than 35s with no
  // response at all, stop waiting and verify DB state automatically.
  // This prevents the UI being permanently stuck on "Submitting…" even if
  // the server-side 25s timeout guard somehow doesn't fire.
  let timedOut = false;
  const clientTimeout = setTimeout(async () => {
    timedOut = true;
    showToast('⚠️ Taking longer than expected — checking if your data was saved…', 'warn');
    try {
      const check = await enrollment.getData();
      if (['SUBMITTED', 'APPROVED'].includes(check?.enrollment?.enrollment_status)) {
        _applySuccessResult(check.enrollment, check.existing_dependents || []);
        showEnrollmentSuccessModal();
        setTimeout(() => renderEnrollmentForm(), 1500);
      } else {
        _resetBtn();
        showToast('Submission timed out. Please try submitting again.', 'error');
      }
    } catch {
      _resetBtn();
      showToast('Submission timed out. Please refresh and try again.', 'error');
    }
  }, 35000); // 35s client timeout

  // Helper: apply successful result to enrollState from any code path
  function _applySuccessResult(enrollmentRecord, members) {
    enrollState.existingEnrollment = {
      enrollment_id: enrollmentRecord.enrollment_id,
      enrollment_status: enrollmentRecord.enrollment_status || 'SUBMITTED',
      submitted_at: enrollmentRecord.submitted_at || new Date().toISOString(),
    };
    if (Array.isArray(members) && members.length > 0) {
      // FIX: Filter out Self — same reason as in renderEnrollmentForm.
      // After submit/retry, the fresh insured_members from the API includes
      // the Self row; excluding it prevents Self appearing in the dependents list.
      enrollState.dependents = members
        .filter(m => m.relationship !== 'Self')
        .map(m => ({
          name: m.insured_name,
          relationship: m.relationship,
          dob: m.date_of_birth,
          gender: m.gender,
          sumInsured: m.sum_insured,
        }));
    }
  }

  try {
    const payload = buildEnrollmentPayload('submit');
    const result = await enrollment.submit(payload);

    // If the client timeout already fired while we were waiting, don't
    // double-show the success modal — it's already been handled.
    if (timedOut) return;
    clearTimeout(clientTimeout);

    if (result && result.enrollment_id) {
      _applySuccessResult(
        { enrollment_id: result.enrollment_id, enrollment_status: result.status, submitted_at: new Date().toISOString() },
        result.insured_members || []
      );
    }

    showEnrollmentSuccessModal();
    setTimeout(() => renderEnrollmentForm(), 1500);

  } catch(error) {
    if (timedOut) return; // timeout handler already took over
    clearTimeout(clientTimeout);

    // ── Network error (TCP drop / Render cold-start) ───────────────────────
    // fetchWithRetry already retried once. The DB write likely succeeded but
    // the HTTP response was never delivered. Verify DB state before showing
    // an error — in most cases the submission WAS saved.
    if (error.isNetworkError || error.isTimeout) {
      const msg = error.isTimeout
        ? '⚠️ Server timeout — verifying if submission was saved…'
        : '⚠️ Network interruption — verifying if submission was saved…';
      showToast(msg, 'warn');
      try {
        const check = await enrollment.getData();
        if (['SUBMITTED', 'APPROVED'].includes(check?.enrollment?.enrollment_status)) {
          _applySuccessResult(check.enrollment, check.existing_dependents || []);
          showEnrollmentSuccessModal();
          setTimeout(() => renderEnrollmentForm(), 1500);
          return;
        }
        // DB says not submitted — genuine failure, let user retry
        _resetBtn();
        showToast('Submission failed — your data was not saved. Please try again.', 'error');
        return;
      } catch {
        // Even the verify call failed — tell user to refresh and check
        _resetBtn();
        showToast('Could not verify submission status. Please refresh the page to check if your enrollment was saved.', 'warn');
        return;
      }
    }

    // ── Rate limit hit ─────────────────────────────────────────────────────
    if (error.isRateLimit) {
      _resetBtn();
      showToast('Too many requests — please wait 1 minute and try submitting again.', 'error');
      return;
    }

    // ── All other errors (validation, auth, etc.) ──────────────────────────
    _resetBtn();
    showToast(error.message || 'Submission failed. Please try again.', 'error');
  }
}

function showEnrollmentSuccessModal() {
  // Remove any existing success modal
  const existing = document.getElementById('enroll-success-modal');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'enroll-success-modal';
  overlay.style.cssText = `
    position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:9999;
    display:flex;align-items:center;justify-content:center;padding:20px;
    animation:fadeIn .2s ease;
  `;
  overlay.innerHTML = `
    <div style="background:white;border-radius:20px;padding:40px 36px;max-width:460px;width:100%;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.25);animation:slideUp .3s ease">
      <div style="font-size:56px;margin-bottom:16px">🎉</div>
      <div style="font-size:22px;font-weight:800;color:#0f172a;margin-bottom:10px">Enrollment Submitted!</div>
      <div style="font-size:15px;color:#475569;line-height:1.6;margin-bottom:24px">
        Your GMC enrollment has been successfully submitted.<br>
        <span style="color:#059669;font-weight:600">Sent for HR review & approval.</span>
      </div>
      <div style="background:#f0fdf4;border:1.5px solid #a7f3d0;border-radius:12px;padding:14px 18px;margin-bottom:24px;font-size:13px;color:#065f46">
        ✅ You will be notified once your enrollment is approved by HR.
      </div>
      <button onclick="document.getElementById('enroll-success-modal').remove()" style="background:#1d4ed8;color:white;border:none;border-radius:10px;padding:12px 32px;font-size:15px;font-weight:700;cursor:pointer;font-family:inherit">Got it →</button>
    </div>
  `;

  // Add animations
  if (!document.getElementById('enroll-modal-styles')) {
    const style = document.createElement('style');
    style.id = 'enroll-modal-styles';
    style.textContent = `
      @keyframes fadeIn { from{opacity:0} to{opacity:1} }
      @keyframes slideUp { from{transform:translateY(20px);opacity:0} to{transform:translateY(0);opacity:1} }
    `;
    document.head.appendChild(style);
  }

  document.body.appendChild(overlay);
  // Auto-close after 8 seconds
  setTimeout(() => { if (overlay.parentNode) overlay.remove(); }, 8000);
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── ADMIN / HR: GMC ENROLLMENT REVIEW ────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

let adminEnrollFilter = 'ALL';

async function renderAdminEnrollments() {
  const c = document.getElementById('content');
  c.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">📋 GMC Enrollment Review</div>
        <div class="page-sub">Review, approve, reject or request correction on employee enrollments</div>
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-secondary btn-sm" onclick="loadAdminEnrollments('ALL')">All</button>
        <button class="btn btn-secondary btn-sm" onclick="loadAdminEnrollments('SUBMITTED')">⏳ Pending</button>
        <button class="btn btn-secondary btn-sm" onclick="loadAdminEnrollments('APPROVED')">✅ Approved</button>
        <button class="btn btn-secondary btn-sm" onclick="loadAdminEnrollments('REJECTED')">❌ Rejected</button>
        <button class="btn btn-secondary btn-sm" onclick="loadAdminEnrollments('DRAFT')">📝 Draft</button>
      </div>
    </div>
    <div id="admin-enroll-stats" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:12px;margin-bottom:20px"></div>
    <div id="admin-enroll-table"><div class="loading"><div class="spinner"></div> Loading…</div></div>
  `;
  await loadAdminEnrollments('ALL');
}

async function loadAdminEnrollments(filter) {
  adminEnrollFilter = filter;
  const cont = document.getElementById('admin-enroll-table');
  if (!cont) return;
  cont.innerHTML = '<div class="loading"><div class="spinner"></div> Loading…</div>';

  try {
    const res = await adminEnrollment.list(filter);
    const data = res?.data || [];

    // Stats
    const all = filter === 'ALL' ? data : null;
    if (all !== null || filter === 'ALL') {
      const stats = document.getElementById('admin-enroll-stats');
      if (stats) {
        const cnt = (st) => data.filter(e => e.enrollment_status === st).length;
        stats.innerHTML = [
          { label:'Total', val: data.length, cls:'blue' },
          { label:'Pending', val: cnt('SUBMITTED'), cls:'amber' },
          { label:'Approved', val: cnt('APPROVED'), cls:'green' },
          { label:'Rejected', val: cnt('REJECTED'), cls:'purple' },
        ].map(s => `
          <div class="stat-card ${s.cls}" style="padding:16px">
            <div class="stat-label">${s.label}</div>
            <div class="stat-value" style="font-size:28px">${s.val}</div>
          </div>`).join('');
      }
    }

    if (!data.length) {
      cont.innerHTML = '<div class="empty-state"><div class="icon">📭</div>No enrollments found</div>';
      return;
    }

    const statusBadge = (st) => {
      const map = {DRAFT:'badge-amber',SUBMITTED:'badge-blue',APPROVED:'badge-green',REJECTED:'badge-red',CORRECTION_REQUIRED:'badge-amber'};
      return `<span class="badge ${map[st]||'badge-blue'}">${st}</span>`;
    };

    cont.innerHTML = `
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr><th>Emp ID</th><th>Name</th><th>Dept</th><th>Sum Insured</th><th>Total Premium</th><th>Deduction</th><th>Members</th><th>Status</th><th>Submitted</th><th>Actions</th></tr></thead>
          <tbody>
            ${data.map(e => `
              <tr>
                <td><code>${e.emp_id}</code></td>
                <td><strong>${e.emp_name}</strong></td>
                <td>${e.department||'—'}</td>
                <td>${e.selected_sum_insured ? enrollFmt(Number(e.selected_sum_insured)) : '—'}</td>
                <td>${e.summary?.total_insurer_premium ? enrollFmt(Number(e.summary.total_insurer_premium)) : '—'}</td>
                <td>${e.summary?.salary_deduction > 0 ? '<span style="color:var(--danger);font-weight:600">'+enrollFmt(Number(e.summary.salary_deduction))+'</span>' : '<span style="color:var(--hr)">Nil</span>'}</td>
                <td style="text-align:center">—</td>
                <td>${statusBadge(e.enrollment_status)}</td>
                <td style="font-size:11px;color:var(--text3)">${e.submitted_at ? new Date(e.submitted_at).toLocaleDateString('en-IN') : '—'}</td>
                <td><button class="btn btn-primary btn-sm" onclick="openAdminEnrollModal(${e.enrollment_id})">Review</button></td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
  } catch(e) {
    cont.innerHTML = `<div class="empty-state"><div class="icon">⚠️</div>${e.message}</div>`;
  }
}

async function openAdminEnrollModal(id) {
  document.getElementById('modal-title').textContent = '📋 Enrollment Review';
  document.getElementById('modal-save-btn').style.display = 'none';
  document.getElementById('modal-body').innerHTML = '<div class="loading"><div class="spinner"></div> Loading…</div>';
  document.getElementById('modal-overlay').classList.add('open');

  try {
    const res = await adminEnrollment.detail(id);
    const { enrollment: enroll, insured_members, summary, audit } = res;

    const statusBadge = (st) => {
      const map = {DRAFT:'badge-amber',SUBMITTED:'badge-blue',APPROVED:'badge-green',REJECTED:'badge-red'};
      return `<span class="badge ${map[st]||'badge-blue'}">${st}</span>`;
    };
    const isPending = enroll.enrollment_status === 'SUBMITTED';

    document.getElementById('modal-title').textContent = `📋 ${enroll.emp_name} (${enroll.emp_id}) — ${enroll.enrollment_status}`;
    document.getElementById('modal-body').innerHTML = `
      ${enroll.admin_remarks ? `<div style="background:#fef3c7;border:1px solid #fcd34d;border-radius:10px;padding:12px;font-size:13px;color:#92400e;margin-bottom:14px"><strong>Previous Remarks:</strong> ${enroll.admin_remarks}</div>` : ''}

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;font-size:13px;margin-bottom:14px">
        <div>Emp ID: <strong><code>${enroll.emp_id}</code></strong></div>
        <div>Sum Insured: <strong>${enroll.selected_sum_insured ? enrollFmt(Number(enroll.selected_sum_insured)) : '—'}</strong></div>
        <div>DOJ: <strong>${enroll.date_of_joining||'—'}</strong></div>
        <div>Mobile: <strong>${enroll.mobile_number||'—'}</strong></div>
        <div>Email: <strong>${enroll.email_id||'—'}</strong></div>
        <div>Status: ${statusBadge(enroll.enrollment_status)}</div>
        ${summary ? `
        <div>Total Premium: <strong>${enrollFmt(Number(summary.total_insurer_premium))}</strong></div>
        <div>CTC GMC Available: <strong>${enrollFmt(Number(summary.total_ctc_gmc_available))}</strong>${summary._ctc_source === 'live_view' ? ' <span style="font-size:10px;background:#d1fae5;color:#065f46;padding:1px 6px;border-radius:4px">live view ✓</span>' : ' <span style="font-size:10px;background:#fef3c7;color:#92400e;padding:1px 6px;border-radius:4px">⚠ saved at submission — may be stale</span>'}</div>
        <div>Salary Deduction: <strong style="color:${Number(summary.salary_deduction)>0?'var(--danger)':'var(--hr)'}">${Number(summary.salary_deduction)>0 ? enrollFmt(Number(summary.salary_deduction)) : 'Nil'}</strong></div>
        <div>GMC Refund: <strong style="color:var(--hr)">${Number(summary.gmc_refund)>0 ? enrollFmt(Number(summary.gmc_refund)) : 'Nil'}</strong></div>` : ''}
      </div>

      ${insured_members?.length ? `
      <div style="font-weight:700;font-size:13px;margin-bottom:8px">Insured Members (${insured_members.length})</div>
      <div style="overflow-x:auto;margin-bottom:14px">
        <table class="data-table" style="font-size:12px">
          <thead><tr><th>Name</th><th>Relation</th><th>DOB</th><th>Age</th><th>Annual Premium</th><th>Coverage Days</th><th>Pro-rated Premium</th></tr></thead>
          <tbody>
            ${insured_members.map(m=>`<tr>
              <td>${m.insured_name||'—'}</td><td>${m.relationship||'—'}</td><td>${m.date_of_birth||'—'}</td>
              <td>${m.age_as_on_doj||'—'}</td><td>${m.annual_premium ? enrollFmt(Number(m.annual_premium)) : '—'}</td>
              <td>${m.coverage_days||'—'}</td><td><strong>${m.prorated_premium ? enrollFmt(Number(m.prorated_premium)) : '—'}</strong></td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>` : '<div style="font-size:13px;color:var(--text3);margin-bottom:14px">Self only (no dependents)</div>'}

      ${isPending ? `
      <div class="form-group" style="margin-bottom:12px">
        <label>Admin Remarks (required for Reject / Correction)</label>
        <textarea id="admin-enroll-remarks" rows="3" placeholder="Enter reason for rejection or correction needed…" style="width:100%;border:1.5px solid var(--border);border-radius:9px;padding:9px 12px;font-family:inherit;font-size:13px;resize:vertical"></textarea>
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-danger" onclick="doAdminEnrollAction(${id},'REJECTED')">❌ Reject</button>
        <button class="btn btn-secondary" onclick="doAdminEnrollAction(${id},'CORRECTION_REQUIRED')">🔁 Request Correction</button>
        <button class="btn btn-success" onclick="doAdminEnrollAction(${id},'APPROVED')">✅ Approve</button>
      </div>` : `<div style="font-size:13px;color:var(--text3)">Status: <strong>${enroll.enrollment_status}</strong>. Reviewed by: ${enroll.reviewed_by||'—'} on ${enroll.reviewed_at ? new Date(enroll.reviewed_at).toLocaleDateString('en-IN') : '—'}</div>`}
    `;
  } catch(e) {
    document.getElementById('modal-body').innerHTML = `<div class="empty-state"><div class="icon">⚠️</div>${e.message}</div>`;
  }
}

async function doAdminEnrollAction(id, action) {
  const remarks = document.getElementById('admin-enroll-remarks')?.value?.trim() || '';
  if ((action === 'REJECTED' || action === 'CORRECTION_REQUIRED') && !remarks) {
    showToast('Please enter remarks before ' + action, 'error'); return;
  }

  // Disable all action buttons during the request to prevent double-clicks
  const actionBtns = document.querySelectorAll('#modal-body .btn-danger, #modal-body .btn-secondary, #modal-body .btn-success');
  actionBtns.forEach(b => { b.disabled = true; b.style.opacity = '0.6'; });

  const actionLabel = { APPROVED: 'Approving…', REJECTED: 'Rejecting…', CORRECTION_REQUIRED: 'Requesting…' }[action] || 'Processing…';
  const activeBtn = [...actionBtns].find(b => b.textContent.toLowerCase().includes(
    action === 'APPROVED' ? 'approve' : action === 'REJECTED' ? 'reject' : 'correction'
  ));
  if (activeBtn) activeBtn.textContent = actionLabel;

  try {
    await adminEnrollment.review(id, action, remarks);
    const successMsg = action === 'APPROVED'
      ? 'Enrollment Approved ✅'
      : action === 'REJECTED'
      ? 'Enrollment Rejected'
      : 'Correction requested';
    showToast(successMsg, action === 'APPROVED' ? 'success' : 'warn');
    closeModal();
    await loadAdminEnrollments(adminEnrollFilter);
  } catch(e) {
    if (e.isNetworkError) {
      // Network dropped — verify what actually happened in the DB before assuming failure
      showToast('⚠️ Network error — verifying if action was saved…', 'warn');
      closeModal();
      setTimeout(async () => {
        try {
          const res = await adminEnrollment.detail(id);
          const actualStatus = res?.enrollment?.enrollment_status;
          if (actualStatus === action || (action === 'CORRECTION_REQUIRED' && actualStatus === 'DRAFT')) {
            showToast(`✅ Confirmed: Enrollment ${action} was saved successfully.`, 'success');
          } else {
            showToast(`⚠️ Action may NOT have saved (status is ${actualStatus}). Please try again.`, 'error');
          }
        } catch {
          showToast('⚠️ Could not verify — please refresh and check status manually.', 'warn');
        }
        await loadAdminEnrollments(adminEnrollFilter);
      }, 2500);
      return;
    }
    // Non-network error — re-enable buttons so user can retry without closing modal
    showToast(e.message || 'Action failed. Please try again.', 'error');
    actionBtns.forEach(b => { b.disabled = false; b.style.opacity = ''; });
    if (activeBtn) {
      const labels = { APPROVED: '✅ Approve', REJECTED: '❌ Reject', CORRECTION_REQUIRED: '🔁 Request Correction' };
      activeBtn.textContent = labels[action] || action;
    }
  }
}

// ─── Expose new functions ──────────────────────────────────────────────────────
window.renderEnrollStep      = renderEnrollStep;
window.addDependent          = addDependent;
window.removeDependent       = removeDependent;
window.enrollStep2Next       = enrollStep2Next;
window.enrollStep3Next       = enrollStep3Next;
window.submitEnrollment      = submitEnrollment;
window.enrollAutoSave        = enrollAutoSave;
window.fmtDate               = fmtDate;
window.refreshPremiumPreview = refreshPremiumPreview;
window.renderLivePremiumTable = renderLivePremiumTable;
window.loadAdminEnrollments  = loadAdminEnrollments;
window.openAdminEnrollModal  = openAdminEnrollModal;
window.doAdminEnrollAction   = doAdminEnrollAction;

// ═══════════════════════════════════════════════════════════════════════════════
// ─── LOGIN PAGE NAVIGATION ────────────────────────────────────────────────────

function showLoginPanel() {
  document.getElementById('login-panel').style.display = '';
  document.getElementById('forgot-panel').style.display = 'none';
  document.getElementById('force-change-panel').style.display = 'none';
  const _o = document.getElementById('otp-panel'); if (_o) _o.style.display = 'none';
}

function showForgotPanel() {
  document.getElementById('login-panel').style.display = 'none';
  document.getElementById('forgot-panel').style.display = '';
  document.getElementById('force-change-panel').style.display = 'none';
  const _o = document.getElementById('otp-panel'); if (_o) _o.style.display = 'none';
  document.getElementById('forgot-error').style.display = 'none';
  document.getElementById('forgot-success').style.display = 'none';
  const emailEl = document.getElementById('login-email');
  if (emailEl?.value) document.getElementById('forgot-email').value = emailEl.value;
}

function showForceChangePanel() {
  document.getElementById('login-panel').style.display = 'none';
  document.getElementById('forgot-panel').style.display = 'none';
  document.getElementById('force-change-panel').style.display = '';
  const _o = document.getElementById('otp-panel'); if (_o) _o.style.display = 'none';
}

// ─── FORGOT PASSWORD ──────────────────────────────────────────────────────────
async function doForgotPassword() {
  const email = document.getElementById('forgot-email')?.value?.trim();
  const errEl  = document.getElementById('forgot-error');
  const succEl = document.getElementById('forgot-success');
  const btn    = document.getElementById('forgot-btn');

  errEl.style.display = 'none';
  succEl.style.display = 'none';

  if (!email) {
    errEl.textContent = 'Please enter your email address.';
    errEl.style.display = 'block';
    return;
  }

  btn.disabled = true; btn.textContent = '⏳ Sending…';
  try {
    await auth.forgotPassword(email);
    succEl.textContent = '✅ If this email is registered, a password reset link has been sent. Check your inbox (and spam folder).';
    succEl.style.display = 'block';
    btn.textContent = 'Send Reset Link';
    btn.disabled = false;
  } catch (e) {
    errEl.textContent = e.message || 'Failed to send reset link. Please try again.';
    errEl.style.display = 'block';
    btn.disabled = false; btn.textContent = 'Send Reset Link';
  }
}

// ─── FORCE CHANGE PASSWORD (first login) ─────────────────────────────────────
async function doForceChangePassword() {
  const currentPwd = document.getElementById('fc-current')?.value;
  const newPwd     = document.getElementById('fc-new')?.value;
  const confirmPwd = document.getElementById('fc-confirm')?.value;
  const errEl      = document.getElementById('fc-error');
  const btn        = document.getElementById('fc-btn');

  errEl.style.display = 'none';

  if (!currentPwd) return showFcErr('Please enter your current password (date of birth as DDMMYYYY).');
  if (!newPwd || newPwd.length < 8) return showFcErr('New password must be at least 8 characters.');
  if (!/[a-zA-Z]/.test(newPwd)) return showFcErr('New password must contain at least one letter.');
  if (!/\d/.test(newPwd)) return showFcErr('New password must contain at least one number.');
  if (newPwd !== confirmPwd) return showFcErr('Passwords do not match.');
  if (newPwd === currentPwd) return showFcErr('New password must be different from your current password.');

  function showFcErr(msg) {
    errEl.textContent = msg; errEl.style.display = 'block';
    btn.disabled = false; btn.textContent = 'Set Password & Continue →';
  }

  btn.disabled = true; btn.textContent = '⏳ Updating…';

  try {
    await auth.changePassword(currentPwd, newPwd);
    showToast('✅ Password changed successfully! Loading your dashboard…', 'success');
    // Update local user state and proceed to app
    const user = tokenStore.getUser();
    if (user) { user.must_change_password = false; tokenStore.setUser(user); }
    document.getElementById('login-page').style.display = 'none';
    document.getElementById('app').style.display = '';
    navigate('dashboard');
  } catch (e) {
    showFcErr(e.message || 'Failed to change password. Please try again.');
  }
}

// ─── CHANGE PASSWORD MODAL (for logged-in users) ──────────────────────────────
function showChangePasswordModal() {
  const modal = document.getElementById('change-password-modal');
  modal.style.display = 'flex';
  document.getElementById('cp-current').value = '';
  document.getElementById('cp-new').value = '';
  document.getElementById('cp-confirm').value = '';
  document.getElementById('cp-error').style.display = 'none';
  document.getElementById('cp-success').style.display = 'none';
  document.getElementById('cp-btn').disabled = false;
  document.getElementById('cp-btn').textContent = 'Update Password';
}

function hideChangePasswordModal() {
  document.getElementById('change-password-modal').style.display = 'none';
}

async function doChangePassword() {
  const currentPwd = document.getElementById('cp-current')?.value;
  const newPwd     = document.getElementById('cp-new')?.value;
  const confirmPwd = document.getElementById('cp-confirm')?.value;
  const errEl      = document.getElementById('cp-error');
  const succEl     = document.getElementById('cp-success');
  const btn        = document.getElementById('cp-btn');

  errEl.style.display = 'none';
  succEl.style.display = 'none';

  if (!currentPwd) return showCpErr('Please enter your current password.');
  if (!newPwd || newPwd.length < 8) return showCpErr('New password must be at least 8 characters.');
  if (!/[a-zA-Z]/.test(newPwd)) return showCpErr('New password must contain at least one letter.');
  if (!/\d/.test(newPwd)) return showCpErr('New password must contain at least one number.');
  if (newPwd !== confirmPwd) return showCpErr('New passwords do not match.');
  if (newPwd === currentPwd) return showCpErr('New password must be different from current.');

  function showCpErr(msg) {
    errEl.textContent = msg; errEl.style.display = 'block';
    btn.disabled = false; btn.textContent = 'Update Password';
  }

  btn.disabled = true; btn.textContent = '⏳ Updating…';

  try {
    await auth.changePassword(currentPwd, newPwd);
    succEl.textContent = '✅ Password changed successfully!';
    succEl.style.display = 'block';
    btn.textContent = 'Update Password';
    btn.disabled = false;
    // Update local must_change_password flag
    const user = tokenStore.getUser();
    if (user) { user.must_change_password = false; tokenStore.setUser(user); }
    setTimeout(() => hideChangePasswordModal(), 1800);
  } catch (e) {
    showCpErr(e.message || 'Failed to change password. Please try again.');
  }
}

window.showLoginPanel          = showLoginPanel;
window.showForgotPanel         = showForgotPanel;
window.doForgotPassword        = doForgotPassword;
window.doForceChangePassword   = doForceChangePassword;
window.doVerifyOtp             = doVerifyOtp;
window.doResendOtp             = doResendOtp;
window.showOtpPanel            = showOtpPanel;
window.showChangePasswordModal = showChangePasswordModal;
window.hideChangePasswordModal = hideChangePasswordModal;
window.doChangePassword        = doChangePassword;

// ═══════════════════════════════════════════════════════════════════════════════
// ─── MOBILE SIDEBAR TOGGLE ────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebar-overlay');
  const btn     = document.getElementById('hamburger-btn');
  const isOpen  = sidebar.classList.contains('open');
  if (isOpen) {
    sidebar.classList.remove('open');
    overlay.classList.remove('show');
    btn.classList.remove('open');
  } else {
    sidebar.classList.add('open');
    overlay.classList.add('show');
    btn.classList.add('open');
  }
}

function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebar-overlay').classList.remove('show');
  document.getElementById('hamburger-btn').classList.remove('open');
}

function navigateAndClose(page) {
  closeSidebar();
  navigate(page);
}

window.toggleSidebar    = toggleSidebar;
window.closeSidebar     = closeSidebar;
window.navigateAndClose = navigateAndClose;
// Inline onclick handlers run in global scope where module-scoped `state` is not
// visible. goHome() reads state here (module scope) so the Dashboard/Home nav works.
function goHome() { navigateAndClose(state.role === 'employee' ? 'employee_dashboard' : 'dashboard'); }
window.goHome = goHome;

// ═══════════════════════════════════════════════════════════════════════════════
// ─── HIDDEN COLUMNS FILTER ────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

const HIDDEN_COLS = new Set(['created_at','updated_at','created_by','updated_by','updated_at_ts','created_at_ts']);

function visibleCols(cols) {
  return cols.filter(c => !HIDDEN_COLS.has(c));
}

// ── Selected rows state ──────────────────────────────────────────────────────
let _selectedRows = new Set();  // stores row[tbl.key] values

function _getSelected() { return [..._selectedRows]; }

function _toggleSelectAll(cb, pageKey) {
  const tbl  = TABLES[pageKey];
  const rows = document.querySelectorAll('#tbl-export-data tbody tr');
  if (cb.checked) {
    rows.forEach(tr => {
      const keyVal = tr.dataset.rowkey;
      if (keyVal) { _selectedRows.add(keyVal); tr.classList.add('row-selected'); }
    });
  } else {
    rows.forEach(tr => {
      tr.classList.remove('row-selected');
      _selectedRows.delete(tr.dataset.rowkey);
    });
  }
  _updateSelectionBar(pageKey, tbl);
}

function _toggleRowSelect(cb, keyVal, pageKey) {
  const tbl = TABLES[pageKey];
  const tr  = cb.closest('tr');
  if (cb.checked) { _selectedRows.add(keyVal); tr.classList.add('row-selected'); }
  else            { _selectedRows.delete(keyVal); tr.classList.remove('row-selected'); }
  // Update select-all checkbox state
  const allCbs = document.querySelectorAll('#tbl-export-data tbody .row-cb');
  const allChecked = [...allCbs].every(c => c.checked);
  const someChecked = [...allCbs].some(c => c.checked);
  const masterCb = document.getElementById('select-all-cb');
  if (masterCb) { masterCb.checked = allChecked; masterCb.indeterminate = someChecked && !allChecked; }
  _updateSelectionBar(pageKey, tbl);
}

function _updateSelectionBar(pageKey, tbl) {
  const bar  = document.getElementById('tbl-selection-bar');
  const cnt  = _selectedRows.size;
  if (!bar) return;
  if (cnt === 0) { bar.style.display = 'none'; return; }
  bar.style.display = 'flex';
  const countEl = bar.querySelector('.sel-count');
  if (countEl) countEl.textContent = `${cnt} row${cnt>1?'s':''} selected`;
}

function _clearSelection(pageKey) {
  _selectedRows.clear();
  document.querySelectorAll('#tbl-export-data tbody tr').forEach(tr => {
    tr.classList.remove('row-selected');
    const cb = tr.querySelector('.row-cb');
    if (cb) cb.checked = false;
  });
  const masterCb = document.getElementById('select-all-cb');
  if (masterCb) { masterCb.checked = false; masterCb.indeterminate = false; }
  const bar = document.getElementById('tbl-selection-bar');
  if (bar) bar.style.display = 'none';
}

async function _deleteSelected(pageKey) {
  const tbl  = TABLES[pageKey];
  const keys = [..._selectedRows];
  if (keys.length === 0) return;
  if (!confirm(`Delete ${keys.length} selected row(s)? This cannot be undone.`)) return;
  try {
    await Promise.all(keys.map(k => tables.remove(tbl.name, k, tbl.key)));
    showToast(`${keys.length} row(s) deleted`, 'success');
    _clearSelection(pageKey);
    await loadTableData(pageKey);
  } catch(e) { showToast(e.message, 'error'); }
}

function _exportSelected(pageKey) {
  const tbl  = TABLES[pageKey];
  const keys = new Set([..._selectedRows]);
  const rows = (state.tableData || []).filter(r => keys.has(String(r[tbl.key])));
  if (rows.length === 0) { showToast('No rows selected', 'error'); return; }
  const cols = visibleCols(tbl.columns);
  const wsData = [cols.map(c => c.replace(/_/g,' ')), ...rows.map(r => cols.map(c => r[c]??''))];
  const ws = XLSX.utils.aoa_to_sheet(wsData);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, tbl.label.slice(0,31));
  XLSX.writeFile(wb, `${tbl.label}_selected_${new Date().toISOString().slice(0,10)}.xlsx`);
}

// ── Table client-side quick search ───────────────────────────────────────────
function _tableQuickSearch(val, pageKey) {
  const q = val.trim().toLowerCase();
  const rows = document.querySelectorAll('#tbl-export-data tbody tr');
  let visible = 0;
  rows.forEach(tr => {
    const text = tr.textContent.toLowerCase();
    const show = !q || text.includes(q);
    tr.style.display = show ? '' : 'none';
    if (show) visible++;
  });
  const countEl = document.getElementById('tbl-vis-count');
  if (countEl) countEl.textContent = q ? `${visible} matching` : '';
}

// ── Main table renderer (with checkboxes + quick search) ─────────────────────
function renderTableHTML(tbl, rows, pageKey) {
  const cont = document.getElementById('table-container');
  if (!cont) return;
  _selectedRows.clear();  // clear on re-render

  if (rows.length === 0) {
    cont.innerHTML = '<div class="empty-state"><div class="icon">📭</div>No records found</div>';
    return;
  }

  const cols       = visibleCols(tbl.columns);
  const isAdmin    = state.role === 'admin';
  const isEmployee = state.role === 'employee';
  state.exportData = { title: tbl.label, columns: cols, rows: rows.map(r => cols.map(c => r[c]??'')) };

  const totalPages = Math.ceil(state.totalCount / state.pageSize);

  cont.innerHTML = `
    <!-- Quick search within rendered page -->
    <div class="tbl-qs-bar">
      <input class="tbl-qs-input" placeholder="🔍 Quick search in this page…"
        oninput="_tableQuickSearch(this.value,'${pageKey}')">
      <span id="tbl-vis-count" style="font-size:12px;color:var(--text3);white-space:nowrap"></span>
    </div>

    <!-- Selection action bar (hidden until rows selected) -->
    <div id="tbl-selection-bar" style="display:none;align-items:center;gap:10px;padding:8px 12px;background:#dbeafe;border:1px solid #93c5fd;border-radius:10px;margin-bottom:8px;font-size:13px;flex-wrap:wrap">
      <span class="sel-count" style="font-weight:700;color:#1e40af"></span>
      ${!isEmployee && isAdmin ? `<button class="btn btn-danger btn-sm" onclick="_deleteSelected('${pageKey}')">🗑️ Delete Selected</button>` : ''}
      <button class="btn btn-secondary btn-sm" onclick="_exportSelected('${pageKey}')">⬇️ Export Selected</button>
      <button class="btn btn-secondary btn-sm" style="margin-left:auto" onclick="_clearSelection('${pageKey}')">✕ Clear Selection</button>
    </div>

    <div class="table-wrap">
      <div style="overflow-x:auto">
        <table class="data-table" id="tbl-export-data">
          <thead><tr>
            <th style="width:36px;text-align:center;padding:8px 6px">
              <input type="checkbox" id="select-all-cb" title="Select all on this page"
                style="cursor:pointer;width:15px;height:15px"
                onchange="_toggleSelectAll(this,'${pageKey}')">
            </th>
            ${cols.map(c => `<th>${c.replace(/_/g,' ')}</th>`).join('')}
            ${!isEmployee ? '<th>Actions</th>' : ''}
          </tr></thead>
          <tbody>
            ${rows.map(row => {
              const keyVal = String(row[tbl.key]??'');
              return `
              <tr data-rowkey="${escHtml(keyVal)}">
                <td style="text-align:center;padding:6px">
                  <input type="checkbox" class="row-cb" style="cursor:pointer;width:15px;height:15px"
                    onchange="_toggleRowSelect(this,'${escHtml(keyVal)}','${pageKey}')">
                </td>
                ${cols.map(c => `<td title="${escHtml(String(row[c]??''))}">${formatCell(c, row[c])}</td>`).join('')}
                ${!isEmployee ? `<td style="white-space:nowrap">
                  <button class="btn btn-secondary btn-sm" onclick="openEditModal('${pageKey}', ${JSON.stringify(row).replace(/"/g,'&quot;')})">✏️ Edit</button>
                  ${isAdmin ? `<button class="btn btn-danger btn-sm" style="margin-left:4px" onclick="deleteRow('${pageKey}', '${keyVal}')">🗑️</button>` : ''}
                </td>` : ''}
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
      <div class="pagination">
        <span>Page ${state.page + 1} of ${totalPages||1} · <strong>${rows.length}</strong> rows shown · ${state.totalCount} total${(state.search&&state.search.trim())?' <span style="color:var(--text3)">(filtered)</span>':''}</span>
        <div class="pagination-btns">
          <button onclick="changePage(-1)" ${state.page===0?'disabled':''}>← Prev</button>
          <button onclick="changePage(1)"  ${state.page + 1 >= (totalPages||1)?'disabled':''}>Next →</button>
        </div>
      </div>
    </div>
  `;
}

window.renderTableHTML       = renderTableHTML;
window._toggleSelectAll      = _toggleSelectAll;
window._toggleRowSelect      = _toggleRowSelect;
window._clearSelection       = _clearSelection;
window._deleteSelected       = _deleteSelected;
window._exportSelected       = _exportSelected;
window._tableQuickSearch     = _tableQuickSearch;

// ═══════════════════════════════════════════════════════════════════════════════
// ─── IMPROVED EMPLOYEE DASHBOARD ─────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

async function renderEmployeeDashboardV2() {
  const c = document.getElementById('content');
  const empId = state.empId;
  c.innerHTML = `<div class="loading"><div class="spinner"></div> Loading your dashboard…</div>`;

  if (!empId) {
    c.innerHTML = `<div class="empty-state"><div class="icon">⚠️</div><b>Emp ID not linked.</b><br>Contact your Admin to link your Employee ID to your account.</div>`;
    return;
  }

  let result;
  try { result = await views.employeeFull(empId); }
  catch(e) { c.innerHTML = `<div class="empty-state"><div class="icon">⚠️</div>${e.message}</div>`; return; }

  const data = result?.data || {};
  const emp  = data.employees?.[0] || {};

  // ═══════════════════════════════════════════════════════════════════════════
  // CLEAR DATA MODEL (3 mutually-aware sources):
  //  1. insurance_dependents          → 25-26 FINAL data (existing employees)
  //  2. employee_gmc_enrollment_insured → GMC enrollment (NEW JOINEES only)
  //  3. renewal_enrollment_insured_2026_27 → 2026-27 Renewal submission
  //
  // KEY RULE: If insurance_dependents EXISTS → that is final → HIDE gmc_enrollment
  //           If insurance_dependents EMPTY  → new joinee   → SHOW gmc_enrollment
  // ═══════════════════════════════════════════════════════════════════════════
  const insDeps      = data.insurance_dependents || [];
  const gmcInsured   = data.employee_gmc_enrollment_insured || [];
  const renewalInsured = data.renewal_enrollment_insured_2026_27 || [];

  const gmcEnrolls   = data.employee_gmc_enrollment || [];
  const renewalEnrolls = data.renewal_enrollment_2026_27 || [];
  const claims       = data.employee_gmc_claims || [];
  const balance      = data.vw_employee_net_balance_2025_26?.[0] || {};

  // CTC GMC/month for display: prefer vw_renewal_ctc_gmc (increment-aware),
  // fall back to employees.ctc_gmc_per_month.
  const ctcGmcRow     = data.vw_renewal_ctc_gmc?.[0] || {};
  const ctcGmcMonthly = (ctcGmcRow.ctc_gmc_per_month != null && ctcGmcRow.ctc_gmc_per_month !== '')
    ? ctcGmcRow.ctc_gmc_per_month
    : emp.ctc_gmc_per_month;

  // Determine employee type
  const isExistingEmployee = insDeps.length > 0;   // has 25-26 insurance data
  const isNewJoinee        = !isExistingEmployee;   // relies on GMC enrollment

  // Drive nav visibility: insurance eligibility = gmc_inclusion_date present;
  // existing (in insurance_dependents) → Renewal only; new joinee → Enrollment only.
  applyRenewalNavGating(!!emp.gmc_inclusion_date, isExistingEmployee);

  // Latest GMC enrollment (for new joinees)
  const latestGmcEnroll = gmcEnrolls.slice().sort((a, b) => {
    const rank = (s) => s === 'APPROVED' ? 3 : s === 'SUBMITTED' ? 2 : s === 'REJECTED' ? 1 : 0;
    const r = rank(b.enrollment_status) - rank(a.enrollment_status);
    if (r !== 0) return r;
    return new Date(b.updated_at || b.submitted_at || 0) - new Date(a.updated_at || a.submitted_at || 0);
  })[0];

  // Latest renewal enrollment
  const latestRenewal = renewalEnrolls.slice().sort((a, b) =>
    new Date(b.submitted_at || b.updated_at || 0) - new Date(a.submitted_at || a.updated_at || 0)
  )[0];

  const fmtCurr = (v) => (v != null && v !== '' && !isNaN(Number(v))) ? '₹' + Number(v).toLocaleString('en-IN') : '—';

  // ── Determine the ACTIVE sum insured (single source of truth) ──────────────
  let activeSumInsured = null;
  if (isExistingEmployee) {
    activeSumInsured = Math.max(...insDeps.map(d => Number(d.sum_insured || 0)));
  } else if (latestGmcEnroll?.selected_sum_insured) {
    activeSumInsured = Number(latestGmcEnroll.selected_sum_insured);
  }

  // ── Status badge helper ─────────────────────────────────────────────────────
  const statusBadge = (status) => {
    const map = {
      'SUBMITTED': 'badge-blue', 'APPROVED': 'badge-green', 'DRAFT': 'badge-amber',
      'REJECTED': 'badge-red', 'PENDING': 'badge-amber', 'NOT_APPLICABLE': 'badge-gray',
      'ACTIVE': 'badge-green',
    };
    const label = {
      'SUBMITTED': 'Submitted', 'APPROVED': 'Approved', 'DRAFT': 'Pending',
      'REJECTED': 'Rejected', 'PENDING': 'Pending', 'NOT_APPLICABLE': 'Not Applicable',
      'ACTIVE': 'Active',
    };
    return `<span class="badge ${map[status] || 'badge-gray'}">${label[status] || status}</span>`;
  };

  // ── Member card renderer ────────────────────────────────────────────────────
  const memberCard = (m, opts = {}) => {
    const relIcons = { Self:'👤', Spouse:'💑', Son:'👦', Daughter:'👧', Father:'👨', Mother:'👩', 'Father-in-Law':'👴', 'Mother-in-Law':'👵' };
    const rel = m.relationship || m.relation || '';
    const name = m.insured_name || m.dependent_name || m.member_name || '—';
    return `<div class="dep-card">
      <div class="dep-icon">${relIcons[rel] || '👤'}</div>
      <div>
        <div class="dep-name">${name}</div>
        <div class="dep-meta">${rel}${m.date_of_birth ? ' · DOB: ' + fmtDate(m.date_of_birth) : ''}</div>
        ${m.sum_insured ? `<div class="dep-meta">Sum Insured: ${fmtCurr(m.sum_insured)}</div>` : ''}
        ${m.annual_premium ? `<div class="dep-meta">Premium: ${fmtCurr(m.annual_premium)}</div>` : ''}
      </div>
    </div>`;
  };

  // ── Section renderer (used for all 3 data sources) ──────────────────────────
  const renderSection = (title, icon, status, members, note, isApplicable) => {
    if (!isApplicable) {
      return `
        <div style="background:white;border:1px solid var(--border);border-radius:14px;padding:18px;margin-bottom:16px;opacity:0.6">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <div style="font-weight:700;font-size:14px">${icon} ${title}</div>
            ${statusBadge('NOT_APPLICABLE')}
          </div>
          <div style="font-size:12px;color:var(--text3);margin-top:8px">${note || 'Not applicable for your profile.'}</div>
        </div>`;
    }
    return `
      <div style="background:white;border:1px solid var(--border);border-radius:14px;padding:18px;margin-bottom:16px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
          <div style="font-weight:700;font-size:14px">${icon} ${title}</div>
          ${statusBadge(status)}
        </div>
        ${note ? `<div style="font-size:12px;color:var(--text2);margin-bottom:10px">${note}</div>` : ''}
        ${members.length === 0
          ? `<div style="padding:16px;text-align:center;color:var(--text3);font-size:13px">No members recorded.</div>`
          : `<div class="dep-cards-grid">${members.map(m => memberCard(m)).join('')}</div>`
        }
      </div>`;
  };

  c.innerHTML = `
    <!-- Profile Banner -->
    <div class="emp-profile-card">
      <div class="emp-avatar">${(emp.emp_name || state.userName || '?')[0].toUpperCase()}</div>
      <div class="emp-profile-info">
        <div class="emp-profile-name">${emp.emp_name || state.userName}</div>
        <div class="emp-profile-meta">${emp.designation || ''} ${emp.department ? '· ' + emp.department : ''} ${emp.unit ? '· ' + emp.unit : ''}</div>
        <div class="emp-stats-row">
          <div class="emp-stat-chip"><span>ID</span>${empId}</div>
          <div class="emp-stat-chip"><span>DOJ</span>${fmtDate(emp.date_of_joining)}</div>
          ${emp.status ? `<div class="emp-stat-chip"><span>Status</span>${emp.status}</div>` : ''}
          <div class="emp-stat-chip"><span>Type</span>${isExistingEmployee ? 'Existing' : 'New Joinee'}</div>
        </div>
      </div>
    </div>

    <!-- Stats Row -->
    <div class="stats-grid" style="margin-bottom:20px">
      <div class="stat-card blue">
        <div class="stat-icon">🏥</div>
        <div class="stat-label">Sum Insured</div>
        <div class="stat-value" style="font-size:18px">${fmtCurr(activeSumInsured)}</div>
        <div class="stat-sub">Family Floater</div>
      </div>
      <div class="stat-card green">
        <div class="stat-icon">👨‍👩‍👧</div>
        <div class="stat-label">25-26 Closing Balance</div>
        <div class="stat-value" style="font-size:16px;color:${Number(balance.net_balance||0)>=0?'#15803d':'#b91c1c'}">${fmtCurr(balance.net_balance)}</div>
        <div class="stat-sub">${Number(balance.net_balance||0)>=0?'Refundable':'Recovery'}</div>
      </div>
      <div class="stat-card purple">
        <div class="stat-icon">🏨</div>
        <div class="stat-label">Total Claims</div>
        <div class="stat-value">${claims.length}</div>
        <div class="stat-sub">Filed under GMC</div>
      </div>

    </div>

    <!-- Correction concern notice -->
    <div class="info-panel print-hide" style="margin-bottom:20px">
      <div class="info-panel-title">📝 See any incorrect information?</div>
      <div class="info-panel-sub">Use <b>Correction Concerns</b> in the sidebar to raise a request to HR.</div>
    </div>

    <!-- Basic Details -->
    <div class="detail-cards" style="margin-bottom:24px">
      <div class="detail-card">
        <div class="detail-card-title">👤 Personal Details</div>
        <div class="detail-item"><span class="detail-key">Emp ID</span><span class="detail-val"><code>${empId}</code></span></div>
        <div class="detail-item"><span class="detail-key">Full Name</span><span class="detail-val">${emp.emp_name||'—'}</span></div>
        <div class="detail-item"><span class="detail-key">Gender</span><span class="detail-val">${emp.gender||'—'}</span></div>
        <div class="detail-item"><span class="detail-key">Date of Birth</span><span class="detail-val">${fmtDate(emp.date_of_birth)}</span></div>
        <div class="detail-item"><span class="detail-key">Mobile</span><span class="detail-val">${emp.mobile_number||'—'}</span></div>
        <div class="detail-item"><span class="detail-key">Email</span><span class="detail-val" style="font-size:11px">${emp.email_id||'—'}</span></div>
      </div>
      <div class="detail-card">
        <div class="detail-card-title">🏢 Employment Details</div>
        <div class="detail-item"><span class="detail-key">Department</span><span class="detail-val">${emp.department||'—'}</span></div>
        <div class="detail-item"><span class="detail-key">Designation</span><span class="detail-val">${emp.designation||'—'}</span></div>
        <div class="detail-item"><span class="detail-key">Unit</span><span class="detail-val">${emp.unit||'—'}</span></div>
        <div class="detail-item"><span class="detail-key">Date of Joining</span><span class="detail-val">${fmtDate(emp.date_of_joining)}</span></div>
        <div class="detail-item"><span class="detail-key">GMC Inclusion</span><span class="detail-val">${fmtDate(emp.gmc_inclusion_date)}</span></div>
        <div class="detail-item"><span class="detail-key">CTC GMC/Month</span><span class="detail-val">${fmtCurr(ctcGmcMonthly)}</span></div>
      </div>
      <div class="detail-card">
        <div class="detail-card-title">💰 GMC Financials 2025-26</div>
        <div class="detail-item"><span class="detail-key">Total CTC GMC</span><span class="detail-val">${fmtCurr(balance.total_ctc_gmc)}</span></div>
        <div class="detail-item"><span class="detail-key">Opening Balance</span><span class="detail-val">${fmtCurr(balance.opening_balance_24_25)}</span></div>
        <div class="detail-item"><span class="detail-key">Total Premium</span><span class="detail-val">${fmtCurr(balance.total_premium)}</span></div>
        <div class="detail-item"><span class="detail-key">Salary Deducted</span><span class="detail-val">${fmtCurr(balance.salary_gmc_deducted)}</span></div>
        <div class="detail-item"><span class="detail-key">Net Balance</span><span class="detail-val" style="color:${Number(balance.net_balance||0)>=0?'#15803d':'#b91c1c'};font-weight:700">${fmtCurr(balance.net_balance)}</span></div>
      </div>
    </div>

    <!-- ═══ 3 INSURANCE DATA SECTIONS ═══ -->
    <div style="font-size:16px;font-weight:700;margin-bottom:14px;color:#0f172a">🛡️ Insurance Coverage Summary</div>

    ${renderSection(
      '2025-26 Insurance (Final)', '📋',
      'ACTIVE',
      insDeps.map(d => ({ ...d, relationship: d.relationship, insured_name: d.dependent_name || d.insured_name })),
      isExistingEmployee ? `Your finalized 2025-26 policy with ${insDeps.length} member(s).` : null,
      isExistingEmployee
    )}

    ${renderSection(
      'GMC Enrollment (New Joinee)', '🆕',
      latestGmcEnroll?.enrollment_status || 'PENDING',
      gmcInsured.filter(m => !latestGmcEnroll || m.enrollment_id === latestGmcEnroll.enrollment_id),
      isNewJoinee ? 'Your new-joinee GMC enrollment.' : 'You are an existing employee — your 2025-26 insurance above is final.',
      isNewJoinee  // ✅ KEY RULE: Only show if NOT existing employee
    )}

    ${'' /* 2026-27 renewal portal hidden — 25-26 cycle complete */}

    <!-- Claims -->
    <div style="font-size:15px;font-weight:700;margin:24px 0 12px;color:#0f172a">🏥 GMC Claims</div>
    ${claims.length === 0
      ? '<div class="empty-state" style="padding:20px;border-radius:14px;background:white;border:1px solid var(--border)"><div class="icon">📭</div>No claims on record</div>'
      : `<div class="table-wrap"><div style="overflow-x:auto">
        <table class="data-table">
          <thead><tr><th>Claim ID</th><th>Beneficiary</th><th>Hospital</th><th>Admission</th><th>Claim Amt</th><th>Approved</th><th>Status</th></tr></thead>
          <tbody>
            ${claims.map(cl=>`<tr>
              <td><code>${cl.claim_id||'—'}</code></td>
              <td>${cl.benef_name||'—'}</td>
              <td>${cl.hospital_name||'—'}</td>
              <td>${fmtDate(cl.date_of_admission)}</td>
              <td>${cl.claim_amount ? fmtCurr(cl.claim_amount) : '—'}</td>
              <td>${cl.claim_approved_amount ? fmtCurr(cl.claim_approved_amount) : '—'}</td>
              <td><span class="badge badge-amber">${cl.claim_status||'—'}</span></td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div></div>`
    }
  `;
}

// Override the original renderEmployeeDashboard
window.renderEmployeeDashboard = renderEmployeeDashboardV2;

// ─── CTC GMC Edit Modal (employee self-service) ────────────────────────────────
function showCtcEditModal() {
  const overlay = document.getElementById('modal-overlay');
  const title   = document.getElementById('modal-title');
  const body    = document.getElementById('modal-body');
  const saveBtn = document.getElementById('modal-save-btn');
  const cancelBtn = overlay.querySelector('.btn-secondary');

  title.textContent = '✏️ Update Monthly CTC GMC';
  body.innerHTML = `
    <div style="margin-bottom:12px;font-size:13px;color:#64748b">
      Enter your monthly CTC GMC contribution (the company-paid portion of your GMC premium).
      HR can update this later if required.
    </div>
    <div class="form-group">
      <label class="form-label">Monthly CTC GMC Amount (₹)</label>
      <input type="number" id="ctc-edit-input" class="form-input" min="0" step="0.01"
        placeholder="e.g. 1500" style="font-size:16px">
    </div>
    <div id="ctc-edit-msg" style="display:none;margin-top:8px;font-size:13px"></div>
  `;

  saveBtn.style.display = '';
  saveBtn.textContent = 'Save';
  saveBtn.onclick = async () => {
    const val = document.getElementById('ctc-edit-input')?.value?.trim();
    const msgEl = document.getElementById('ctc-edit-msg');
    if (!val || isNaN(parseFloat(val)) || parseFloat(val) < 0) {
      msgEl.style.cssText = 'display:block;color:#dc2626';
      msgEl.textContent = 'Please enter a valid amount (0 or more).';
      return;
    }
    saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
    try {
      await enrollment.updateCtc(parseFloat(val));
      msgEl.style.cssText = 'display:block;color:#059669;font-weight:600';
      msgEl.textContent = '✅ CTC GMC updated successfully!';
      setTimeout(() => {
        closeModal();
        renderEmployeeDashboardV2(); // reload dashboard
      }, 1000);
    } catch(e) {
      msgEl.style.cssText = 'display:block;color:#dc2626';
      msgEl.textContent = e.message || 'Update failed.';
      saveBtn.disabled = false; saveBtn.textContent = 'Save';
    }
  };

  overlay.classList.add('active');
  overlay.style.display = 'flex';
  setTimeout(() => document.getElementById('ctc-edit-input')?.focus(), 100);
}
window.showCtcEditModal = showCtcEditModal;

// ═══════════════════════════════════════════════════════════════════════════════
// ─── F&F GMC STATEMENT PAGE ───────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

let ffData = null;

// ─── Indian Number to Words ───────────────────────────────────────────────────
function numToWords(num) {
  if (num === null || num === undefined || isNaN(num)) return 'Zero Rupees Only';
  const n = Math.abs(Math.round(num));
  if (n === 0) return 'Zero Rupees Only';
  const ones = ['','One','Two','Three','Four','Five','Six','Seven','Eight','Nine',
    'Ten','Eleven','Twelve','Thirteen','Fourteen','Fifteen','Sixteen','Seventeen','Eighteen','Nineteen'];
  const tens = ['','','Twenty','Thirty','Forty','Fifty','Sixty','Seventy','Eighty','Ninety'];
  function twoD(x)  { return x < 20 ? ones[x] : tens[Math.floor(x/10)] + (x%10 ? ' '+ones[x%10] : ''); }
  function threeD(x){ return x < 100 ? twoD(x) : ones[Math.floor(x/100)]+' Hundred'+(x%100 ? ' '+twoD(x%100) : ''); }
  let rem = n, res = '';
  if (rem >= 10000000) { res += threeD(Math.floor(rem/10000000))+' Crore '; rem %= 10000000; }
  if (rem >= 100000)   { res += twoD(Math.floor(rem/100000))+' Lakh ';        rem %= 100000;  }
  if (rem >= 1000)     { res += threeD(Math.floor(rem/1000))+' Thousand ';    rem %= 1000;    }
  if (rem > 0)         { res += threeD(rem); }
  return (num < 0 ? 'Minus ' : '') + res.trim() + ' Rupees Only';
}

// ─── Formatters ───────────────────────────────────────────────────────────────
function fmtINR(v) {
  const n = Math.round(Number(v) || 0);
  return '₹' + n.toLocaleString('en-IN');
}
function fmtPDF(v) {
  const n = Math.round(Number(v) || 0);
  return 'Rs.' + n.toLocaleString('en-IN');
}
function fmtDate(v) {
  if (!v) return '—';
  // Handle YYYY-MM-DD directly (no timezone shift) → DD-MM-YYYY
  const iso = String(v).substring(0, 10);
  const parts = iso.split('-');
  if (parts.length === 3 && parts[0].length === 4) return `${parts[2]}-${parts[1]}-${parts[0]}`;
  // Fallback for other formats
  const d = new Date(v);
  return isNaN(d) ? v : d.toLocaleDateString('en-IN', { day:'2-digit', month:'2-digit', year:'numeric' });
}

// ─── Render F&F Page ──────────────────────────────────────────────────────────
async function renderFFStatementPage() {
  const c = document.getElementById('content');
  c.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">📑 F&amp;F GMC Statement</div>
        <div class="page-sub">Full &amp; Final GMC Settlement Statement for exiting employees</div>
      </div>
    </div>

    <div class="section-card print-hide">
      <div class="section-title">🔍 Search Employee</div>
      <div class="form-grid">
        <div class="form-group">
          <label>Employee ID <span style="color:var(--danger)">*</span></label>
          <input type="text" id="ff-empid" placeholder="e.g. 2888"
            style="font-family:'DM Mono',monospace;text-transform:uppercase"
            onkeydown="if(event.key==='Enter')loadFFData()">
        </div>
        <div style="display:flex;align-items:flex-end;gap:8px">
          <button class="btn btn-primary" onclick="loadFFData()" style="height:38px">🔍 Load Employee</button>
        </div>
      </div>
      <div id="ff-emp-info" style="margin-top:12px"></div>
    </div>

    <div class="section-card print-hide" id="ff-exit-form" style="display:none">
      <div class="section-title">🚪 Exit Details (Edit if needed)</div>
      <div class="form-grid">
        <div class="form-group">
          <label>Exit Date</label>
          <input type="date" id="ff-exit-date">
        </div>
        <div class="form-group">
          <label>Last Working Day</label>
          <input type="date" id="ff-last-working-day">
        </div>
        <div class="form-group">
          <label>Exit Type</label>
          <select id="ff-exit-type">
            <option value="">— Select —</option>
            <option value="Resignation">Resignation</option>
            <option value="Termination">Termination</option>
            <option value="Retirement">Retirement</option>
            <option value="Absconding">Absconding</option>
            <option value="Death">Death</option>
            <option value="Other">Other</option>
          </select>
        </div>
      </div>
      <div style="display:flex;gap:8px;margin-top:4px;flex-wrap:wrap">
        <button class="btn btn-secondary" onclick="saveExitData()">💾 Save Exit Data</button>
        <button class="btn btn-primary"   onclick="generateFFStatement()">📑 Generate Statement</button>
      </div>
    </div>

    <div id="ff-statement-output" style="margin-top:20px"></div>
  `;
}

// ─── Load Employee Data ───────────────────────────────────────────────────────
async function loadFFData() {
  const rawId = (document.getElementById('ff-empid')?.value||'').trim();
  if (!rawId) { showToast('Please enter an Employee ID','error'); return; }
  const infoEl = document.getElementById('ff-emp-info');
  infoEl.innerHTML = '<div class="loading" style="padding:12px 0"><div class="spinner"></div> Loading…</div>';

  try {
    // PRIMARY: vw_gmc_statement_required — single source of truth for all F&F financials
    // This view filters is_active=false so only exited employees appear
    const [
      stmtRes,
      empResult,
      insDepRes,
      ctcIncrRes,
      deducRes,
      claimsRes,
      exitRecRes,
    ] = await Promise.all([
      views.fetch('vw_gmc_statement_required', { emp_filter: rawId, pageSize: 200 })
        .catch(() => ({ data: [] })),
      views.employeeFull(rawId),
      tables.list('insurance_dependents',          { emp_filter: rawId, pageSize: 100 }),
      tables.list('employee_ctc_gmc_increment',    { emp_filter: rawId, pageSize: 100 }),
      tables.list('employee_gmc_actual_deduction', { emp_filter: rawId, pageSize: 100 }),
      tables.list('employee_gmc_claims',           { emp_filter: rawId, pageSize: 100 }),
      tables.list('employee_gmc_exit',             { emp_filter: rawId, pageSize: 10  }),
    ]);

    // vw_gmc_statement_required row for this employee
    const allStmt = stmtRes?.data || [];
    const stmtRow = allStmt.find(r => String(r.emp_id) === String(rawId)) || allStmt[0] || null;

    const empData = empResult?.data || {};
    const emp     = empData.employees?.[0];

    // Need at least employee record OR statement row
    if (!emp && !stmtRow) {
      infoEl.innerHTML = `<div class="empty-state" style="padding:16px"><div class="icon">🔍</div>No employee found: <b>${rawId}</b></div>`;
      return;
    }

    const exitRec = exitRecRes?.data?.[0] || empData.employee_gmc_exit?.[0] || null;

    // Merge: prefer view fields, fallback to employee table
    ffData = {
      empId:      rawId,
      emp:        emp || {},
      stmtRow:    stmtRow || {},
      insDeps:    insDepRes?.data    || [],
      ctcIncrs:   ctcIncrRes?.data   || [],
      deductions: deducRes?.data     || [],
      claims:     claimsRes?.data    || [],
      exitRec,
    };

    const name = stmtRow?.emp_name || emp?.emp_name || rawId;
    const exitDate = stmtRow?.exit_date || exitRec?.exit_date || '';
    const lwDay    = stmtRow?.last_working_day || exitRec?.last_working_day || '';

    infoEl.innerHTML = `
      <div style="background:#d1fae5;border:1px solid #a7f3d0;border-radius:10px;padding:12px 16px;font-size:13px;color:#065f46">
        ✅ <strong>${name}</strong> · <code>${rawId}</code>
        · ${emp?.department||stmtRow?.department||''}
        · DOJ: ${fmtDate(stmtRow?.date_of_joining || emp?.date_of_joining)}
        ${exitDate ? `<br>🚪 Exit: <strong>${fmtDate(exitDate)}</strong>` + (exitRec?.exit_type ? ` · ${exitRec.exit_type}` : '') : '<br>⚠️ No exit date found — employee may still be active in the system'}
        ${stmtRow ? `<br>💰 Final Amount: <strong>${fmtINR(stmtRow.final_ff_gmc_amount)}</strong> (${stmtRow.final_wording})` : ''}
      </div>
    `;

    const exitForm = document.getElementById('ff-exit-form');
    exitForm.style.display = '';
    document.getElementById('ff-exit-date').value        = exitDate || '';
    document.getElementById('ff-last-working-day').value = lwDay    || '';
    document.getElementById('ff-exit-type').value        = exitRec?.exit_type || '';

  } catch(e) {
    console.error(e);
    infoEl.innerHTML = `<div class="empty-state" style="padding:16px"><div class="icon">⚠️</div>${e.message}</div>`;
  }
}

// ─── Save Exit Data ───────────────────────────────────────────────────────────
async function saveExitData() {
  if (!ffData) { showToast('Load employee first', 'error'); return; }
  const exitDate = document.getElementById('ff-exit-date')?.value;
  const lwDay    = document.getElementById('ff-last-working-day')?.value;
  const exitType = document.getElementById('ff-exit-type')?.value;
  if (!exitDate || !exitType) { showToast('Exit date and type required', 'error'); return; }
  try {
    if (ffData.exitRec) {
      await tables.update('employee_gmc_exit', ffData.empId,
        { exit_date: exitDate, last_working_day: lwDay, exit_type: exitType }, 'emp_id');
    } else {
      await tables.insert('employee_gmc_exit',
        { emp_id: ffData.empId, exit_date: exitDate, last_working_day: lwDay, exit_type: exitType });
    }
    showToast('Exit data saved!', 'success');
    await loadFFData();
  } catch(e) { showToast(e.message, 'error'); }
}

// ─── Build Calculation Object from vw_gmc_statement_required ─────────────────
function buildFFCalc() {
  const { emp, stmtRow, insDeps, ctcIncrs, deductions, claims, exitRec } = ffData;

  // ── Exit details: form values > view values > exit record
  const exitDate = document.getElementById('ff-exit-date')?.value
    || stmtRow?.exit_date || exitRec?.exit_date || '';
  const lwDay    = document.getElementById('ff-last-working-day')?.value
    || stmtRow?.last_working_day || exitRec?.last_working_day || '';
  const exitType = document.getElementById('ff-exit-type')?.value
    || exitRec?.exit_type || '—';

  // ── Financials — ALL from vw_gmc_statement_required ─────────────────────────
  // total_premium_exit_employee = total annual FF premium for this employee's family
  const totalPremiumFF    = Math.round(Number(stmtRow?.total_premium_exit_employee || 0));
  // total_ctc_gmc = sum of monthly CTC GMC from Aug to last working day
  const totalCtcGmc       = Math.round(Number(stmtRow?.total_ctc_gmc              || 0));
  // emi_recovered_till_exit = total payroll deductions till exit
  const emiRecovered      = Math.round(Number(stmtRow?.emi_recovered_till_exit    || 0));
  // gmc_opening_balance = carry-forward balance from 2024-25
  const openingBalance    = Math.round(Number(stmtRow?.gmc_opening_balance        || 0));
  // final_ff_gmc_amount: POSITIVE = Payable TO employee (refund), NEGATIVE = Recoverable FROM employee
  const finalAmount       = Math.round(Number(stmtRow?.final_ff_gmc_amount        || 0));
  // final_wording from view's CASE statement
  const finalWording      = stmtRow?.final_wording || (
    finalAmount > 0 ? 'Payable to Employee' :
    finalAmount < 0 ? 'Recoverable from Employee' : 'NIL'
  );

  // ── Latest CTC GMC per month from employee_ctc_gmc_increment ────────────────
  let latestCtcGmc = Number(emp?.ctc_gmc_per_month || 0);
  if (ctcIncrs.length > 0) {
    const sorted = [...ctcIncrs].sort((a,b) =>
      new Date(b.increment_effective_date||0) - new Date(a.increment_effective_date||0));
    latestCtcGmc = Number(sorted[0].new_ctc_gmc_per_month || latestCtcGmc);
  }
  latestCtcGmc = Math.round(latestCtcGmc);

  // ── Claims: "Claimed This Year" = any non-rejected, non-closed claim ─────────
  const activeClaims    = claims.filter(c =>
    !['Rejected','Closed','rejected','closed'].includes(String(c.claim_status||'')));
  const claimedThisYear = activeClaims.length > 0 ? 'Yes' : 'No';

  // ── Insured members — deduplicate, remove duplicate Self rows ────────────────
  const seen = new Set();
  const uniqueDeps = insDeps.filter(d => {
    const key = `${(d.insured_name||'').toLowerCase().trim()}|${(d.relationship||'').toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  // Self shown from employee record; keep only non-Self dependents from table
  const nonSelfDeps = uniqueDeps.filter(d =>
    (d.relationship||'').toLowerCase() !== 'self');

  // Sum insured from insurance_dependents or financials
  const sumInsured = Math.round(Number(
    uniqueDeps[0]?.sum_insured || emp?.sum_insured || 0
  ));

  // ── Payroll deduction total (cross-verify with emi_recovered_till_exit) ───────
  const totalDeductedRaw = deductions.reduce((s,d) => s + Number(d.deducted_amount||0), 0);
  // Prefer view's EMI recovered (authoritative), show breakdown from deductions table
  const totalDeducted    = emiRecovered > 0 ? emiRecovered : Math.round(totalDeductedRaw);

  return {
    empId: ffData.empId,
    empName:     stmtRow?.emp_name     || emp?.emp_name     || ffData.empId,
    doj:         stmtRow?.date_of_joining || emp?.date_of_joining,
    department:  emp?.department,
    designation: emp?.designation,
    dob:         emp?.date_of_birth,
    exitDate, lwDay, exitType,
    // Insurance
    sumInsured, claimedThisYear,
    totalClaims: claims.length, activeClaims: activeClaims.length,
    // Financials (from vw_gmc_statement_required)
    totalPremiumFF,    // Total FF Premium (annual, all family members)
    totalCtcGmc,       // Total CTC GMC (Aug to last working day)
    latestCtcGmc,      // CTC GMC per month (latest increment)
    openingBalance,    // Opening balance from 24-25
    totalDeducted,     // EMI recovered till exit (salary deductions)
    finalAmount,       // + = Payable to employee, - = Recoverable from employee
    finalWording,      // String from view CASE
    // Dependents
    nonSelfDeps, uniqueDeps,
    // Deduction detail rows
    deductions,
  };
}

// ─── Generate HTML Statement ──────────────────────────────────────────────────
async function generateFFStatement() {
  if (!ffData) { showToast('Load employee first', 'error'); return; }
  const exitDate = document.getElementById('ff-exit-date')?.value;
  const exitType = document.getElementById('ff-exit-type')?.value;
  if (!exitDate || !exitType) { showToast('Enter exit date and type first', 'error'); return; }

  const output = document.getElementById('ff-statement-output');
  output.innerHTML = '<div class="loading"><div class="spinner"></div> Building statement…</div>';

  try {
    const c = buildFFCalc();
    // CORRECT SIGN CONVENTION (matches view):
    //   finalAmount > 0 → Payable TO employee (refund) → green
    //   finalAmount < 0 → Recoverable FROM employee → red
    const isRefund   = c.finalAmount > 0;
    const isRecovery = c.finalAmount < 0;
    const absAmount  = Math.abs(c.finalAmount);
    const policyEndForStatement = c.exitDate || c.lwDay || '2026-07-23';
    const policyEndLabel = fmtDate(policyEndForStatement);
    const finalBadgeColor = isRefund ? '#059669' : isRecovery ? '#dc2626' : '#64748b';
    const finalIcon       = isRefund ? '✅' : isRecovery ? '⚠️' : 'ℹ️';

    output.innerHTML = `
      <div class="print-hide" style="display:flex;gap:10px;margin-bottom:16px;flex-wrap:wrap">
        <button class="btn btn-print"     onclick="window.print()">🖨️ Print Statement</button>
        <button class="btn btn-secondary" onclick="downloadFFPDF()">⬇️ Download PDF</button>
      </div>

      <div class="ff-statement" id="ff-statement-doc">

        <!-- ── Header ── -->
        <div class="ff-header">
          <div class="ff-header-company">Global Calcium Pvt Limited</div>
          <div class="ff-header-title">Full &amp; Final — GMC Settlement Statement</div>
          <div class="ff-header-sub">
            Group Medical Cover &nbsp;·&nbsp; Policy Year 24 Jul 2026 – 23 Jul 2027
            &nbsp;·&nbsp; Magma General Insurance Limited / Medi Assist TPA
          </div>
        </div>

        <!-- ── Employee Meta ── -->
        <div class="ff-meta" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:0">
          <div class="ff-meta-item"><div class="ff-meta-label">Employee ID</div>
            <div class="ff-meta-value">${c.empId}</div></div>
          <div class="ff-meta-item"><div class="ff-meta-label">Employee Name</div>
            <div class="ff-meta-value">${c.empName}</div></div>
          <div class="ff-meta-item"><div class="ff-meta-label">Department</div>
            <div class="ff-meta-value">${c.department||'—'}</div></div>
          <div class="ff-meta-item"><div class="ff-meta-label">Designation</div>
            <div class="ff-meta-value">${c.designation||'—'}</div></div>
          <div class="ff-meta-item"><div class="ff-meta-label">Date of Joining</div>
            <div class="ff-meta-value">${fmtDate(c.doj)}</div></div>
          <div class="ff-meta-item"><div class="ff-meta-label">Date of Exit</div>
            <div class="ff-meta-value">${fmtDate(c.exitDate)}</div></div>
          <div class="ff-meta-item"><div class="ff-meta-label">Last Working Day</div>
            <div class="ff-meta-value">${fmtDate(c.lwDay)}</div></div>
          <div class="ff-meta-item"><div class="ff-meta-label">Exit Type</div>
            <div class="ff-meta-value">${c.exitType}</div></div>
        </div>

        <!-- ── Section 1: GMC Summary ── -->
        <div class="ff-section">
          <div class="ff-section-title">🏥 GMC Policy Summary</div>
          <div class="ff-2col" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px">
            <div>
              <div class="ff-row">
                <span class="ff-row-label">Sum Insured (Family Floater)</span>
                <span class="ff-row-value">${fmtINR(c.sumInsured)}</span>
              </div>
              <div class="ff-row">
                <span class="ff-row-label">Insurance Insurer</span>
                <span class="ff-row-value">Magma General Insurance Ltd.</span>
              </div>
              <div class="ff-row">
                <span class="ff-row-label">TPA</span>
                <span class="ff-row-value">Medi Assist Insurance TPA</span>
              </div>
              <div class="ff-row">
                <span class="ff-row-label">Policy Period</span>
                <span class="ff-row-value">24 Jul 2025 – 23 Jul 2026</span>
              </div>
            </div>
            <div>
              <div class="ff-row">
                <span class="ff-row-label">No. of Insured Members</span>
                <span class="ff-row-value">${c.nonSelfDeps.length + 1} (Self + ${c.nonSelfDeps.length} dependents)</span>
              </div>
              <div class="ff-row">
                <span class="ff-row-label">Total Claims Filed</span>
                <span class="ff-row-value">${c.totalClaims}</span>
              </div>
              <div class="ff-row">
                <span class="ff-row-label">Claimed This Year (2025–26)</span>
                <span class="ff-row-value">
                  <span class="badge ${c.claimedThisYear==='Yes'?'badge-amber':'badge-green'}">${c.claimedThisYear}</span>
                </span>
              </div>
              <div class="ff-row">
                <span class="ff-row-label">Coverage Up To</span>
                <span class="ff-row-value">${policyEndLabel} (Exit Date)</span>
              </div>
            </div>
          </div>
        </div>

        <!-- ── Section 2: Premium & CTC GMC Calculation ── -->
        <div class="ff-section">
          <div class="ff-section-title">💰 Premium &amp; CTC GMC Calculation</div>
          <div style="overflow-x:auto">
            <table class="data-table">
              <thead>
                <tr>
                  <th>Description</th>
                  <th>Basis</th>
                  <th style="text-align:right">Amount</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Total FF Premium (All Insured Members)</td>
                  <td style="color:var(--text2);font-size:12px">Policy 24 Jul 2025 – ${policyEndLabel} · pro-rated to exit date</td>
                  <td style="text-align:right;font-weight:700">${fmtINR(c.totalPremiumFF)}</td>
                </tr>
                <tr style="background:#fafafa">
                  <td>CTC GMC Per Month (Latest)</td>
                  <td style="color:var(--text2);font-size:12px">From latest increment record</td>
                  <td style="text-align:right;font-weight:700">${fmtINR(c.latestCtcGmc)}</td>
                </tr>
                <tr>
                  <td>Total CTC GMC Available</td>
                  <td style="color:var(--text2);font-size:12px">GMC financial year Aug–Jul · up to last working day</td>
                  <td style="text-align:right;font-weight:700">${fmtINR(c.totalCtcGmc)}</td>
                </tr>
                <tr style="background:#fafafa">
                  <td>Opening Balance (2024–25 Carry Forward)</td>
                  <td style="color:var(--text2);font-size:12px">Previous year closing balance</td>
                  <td style="text-align:right;font-weight:700">${fmtINR(c.openingBalance)}</td>
                </tr>
                <tr>
                  <td>Total EMI Recovered via Salary Deductions</td>
                  <td style="color:var(--text2);font-size:12px">Payroll deductions till exit</td>
                  <td style="text-align:right;font-weight:700">${fmtINR(c.totalDeducted)}</td>
                </tr>
                <tr style="background:#eff6ff">
                  <td colspan="2" style="font-weight:700;font-size:13px">
                    NET POSITION<br>
                    <span style="font-size:11px;font-weight:400;color:var(--text2)">
                      Total CTC GMC + Opening Balance + EMI Recovered − Total FF Premium
                    </span>
                  </td>
                  <td style="text-align:right;font-weight:800;font-size:15px;color:${finalBadgeColor}">
                    ${fmtINR(c.finalAmount)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- ── Section 3: Insured Family Members ── -->
        <div class="ff-section">
          <div class="ff-section-title">👨‍👩‍👧 Insured Family Members</div>
          <div style="overflow-x:auto">
            <table class="data-table">
              <thead>
                <tr>
                  <th>#</th><th>Name</th><th>Relationship</th><th>DOB</th>
                  <th>Sum Insured</th><th>Status</th><th>Policy Period</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>1</td>
                  <td><strong>${c.empName}</strong></td>
                  <td>Self</td>
                  <td>${fmtDate(c.dob)}</td>
                  <td>${fmtINR(c.sumInsured)}</td>
                  <td><span class="badge badge-green">Active</span></td>
                  <td>24 Jul 2025 – ${policyEndLabel}</td>
                </tr>
                ${c.nonSelfDeps.map((d,i)=>`
                  <tr>
                    <td>${i+2}</td>
                    <td>${d.insured_name||'—'}</td>
                    <td>${d.relationship||'—'}</td>
                    <td>${fmtDate(d.date_of_birth)}</td>
                    <td>${fmtINR(d.sum_insured)}</td>
                    <td><span class="badge ${d.status==='A'||d.status==='Active'?'badge-green':'badge-red'}">
                      ${d.status==='A'||d.status==='Active'?'Active':'Inactive'}
                    </span></td>
                    <td>${fmtDate(d.policy_start_date)||'24 Jul 2025'} – ${policyEndLabel}</td>
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>
        </div>

        <!-- ── Section 4: Payroll Deduction History ── -->
        ${c.deductions.length > 0 ? `
        <div class="ff-section">
          <div class="ff-section-title">📋 Payroll Deduction History</div>
          <div style="overflow-x:auto">
            <table class="data-table">
              <thead>
                <tr><th>Payroll Month</th><th style="text-align:right">Deducted Amount</th></tr>
              </thead>
              <tbody>
                ${(() => {
                  // ✅ FIX: Group by payroll_month — prevents showing duplicate rows
                  // when the deduction table has 2 rows for the same month (e.g. ₹3713 + ₹274)
                  const grouped = Object.values(
                    c.deductions.reduce((acc, d) => {
                      const key = d.payroll_month;
                      if (!acc[key]) acc[key] = { payroll_month: key, deducted_amount: 0, remarks: [] };
                      acc[key].deducted_amount += Number(d.deducted_amount || 0);
                      const r = (d.remarks || '').trim();
                      if (r && r.toLowerCase() !== 'nil') acc[key].remarks.push(r);
                      return acc;
                    }, {})
                  ).sort((a, b) => a.payroll_month.localeCompare(b.payroll_month));
                  return grouped.map(d=>`
                  <tr>
                    <td>${d.payroll_month||'—'}</td>
                    <td style="text-align:right;font-weight:600">${fmtINR(d.deducted_amount)}</td>
                  </tr>`).join('') +
                  `<tr style="background:#eff6ff;font-weight:800">
                    <td>TOTAL (${grouped.length} month${grouped.length !== 1 ? 's' : ''})</td>
                    <td style="text-align:right;color:var(--accent)">${fmtINR(grouped.reduce((s,d)=>s+d.deducted_amount,0))}</td>
                  </tr>`;
                })()}
              </tbody>
            </table>
          </div>
        </div>` : ''}

        <!-- ── Final Settlement Banner ── -->
        <div class="ff-total" style="background:${finalBadgeColor}">
          <div>
            <div class="ff-total-label">${finalIcon} ${c.finalWording}</div>
            <div style="font-size:11px;opacity:.8;margin-top:5px;font-weight:400;font-family:'DM Sans',sans-serif;letter-spacing:.2px">
              ${numToWords(absAmount)}
            </div>
          </div>
          <div class="ff-total-value">${fmtINR(absAmount)}</div>
        </div>

        <!-- ── Signature Footer ── -->
        <div class="ff-footer">
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:24px;margin-bottom:18px">
            <div>
              <div style="font-weight:700;color:var(--text2);font-size:12px;text-transform:uppercase;letter-spacing:.5px">HR / Authorised Signatory</div>
              <div style="border-top:1.5px solid var(--border);margin-top:40px;padding-top:6px;font-size:11px;color:var(--text2)">Name &amp; Signature</div>
            </div>
            <div>
              <div style="font-weight:700;color:var(--text2);font-size:12px;text-transform:uppercase;letter-spacing:.5px">Employee Acknowledgement</div>
              <div style="border-top:1.5px solid var(--border);margin-top:40px;padding-top:6px;font-size:11px;color:var(--text2)">Name &amp; Signature</div>
            </div>
            <div>
              <div style="font-weight:700;color:var(--text2);font-size:12px;text-transform:uppercase;letter-spacing:.5px">Date</div>
              <div style="border-top:1.5px solid var(--border);margin-top:40px;padding-top:6px;font-size:11px;color:var(--text2)">${new Date().toLocaleDateString('en-IN')}</div>
            </div>
          </div>
          <div style="border-top:1px solid var(--border);padding-top:10px;font-size:10.5px;color:var(--text2);line-height:1.6">
            📌 This statement is system-generated on ${new Date().toLocaleString('en-IN')} &nbsp;·&nbsp;
            GCPL Insurance Portal &nbsp;·&nbsp; gcpl.insurance-portal.in &nbsp;·&nbsp;
            For queries: naveen.paun@globalcalciumpharma.com
          </div>
        </div>
      </div>
    `;

    output.scrollIntoView({ behavior:'smooth' });
    showToast('F&F Statement generated!', 'success');
  } catch(e) {
    console.error(e);
    output.innerHTML = `<div class="empty-state"><div class="icon">⚠️</div>${e.message}</div>`;
    showToast(e.message, 'error');
  }
}

// ─── Download PDF ─────────────────────────────────────────────────────────────
function downloadFFPDF() {
  if (!ffData) { showToast('Generate statement first', 'error'); return; }
  try {
    const c = buildFFCalc();
    const isRefund   = c.finalAmount > 0;
    const isRecovery = c.finalAmount < 0;
    const absAmt     = Math.abs(c.finalAmount);
    const policyEndForStatement = c.exitDate || c.lwDay || '2026-07-23';
    const policyEndLabel = fmtDate(policyEndForStatement);
    const bandColor  = isRefund ? [6,95,70] : isRecovery ? [127,29,29] : [30,41,59];

    const doc = new jsPDF({ orientation:'portrait', unit:'mm', format:'a4' });
    const W = 210, M = 14;

    // ── Header
    doc.setFillColor(15,36,96);
    doc.rect(0,0,W,38,'F');
    doc.setFontSize(7.5); doc.setFont('helvetica','bold'); doc.setTextColor(160,185,230);
    doc.text('GLOBAL CALCIUM Pvt Ltd', M, 10);
    doc.setFontSize(16); doc.setTextColor(255,255,255);
    doc.text('Full & Final - GMC Settlement Statement', M, 21);
    doc.setFontSize(8); doc.setFont('helvetica','normal'); doc.setTextColor(180,205,245);
    doc.text('Group Medical Cover | Policy Year 24 Jul 2026 - 23 Jul 2027 | Magma General Insurance', M, 30);

    let y = 46;
    doc.setTextColor(15,23,42);

    // ── Employee Details
    doc.setFontSize(10); doc.setFont('helvetica','bold');
    doc.text('Employee Details', M, y); y += 5;
    doc.autoTable({
      startY: y, margin: { left:M, right:M },
      body: [
        ['Employee ID',      c.empId,                'Employee Name',  c.empName],
        ['Department',       c.department||'—',      'Designation',    c.designation||'—'],
        ['Date of Joining',  fmtDate(c.doj),         'Date of Exit',   fmtDate(c.exitDate)],
        ['Last Working Day', fmtDate(c.lwDay),        'Exit Type',      c.exitType||'—'],
        ['Sum Insured',      fmtPDF(c.sumInsured),    'Claimed This Year', c.claimedThisYear],
        ['No. of Members',   String(c.nonSelfDeps.length+1), 'Total Claims Filed', String(c.totalClaims)],
      ],
      styles:       { fontSize:9, cellPadding:2.8 },
      columnStyles: {
        0: { fontStyle:'bold', fillColor:[237,242,255], cellWidth:40 },
        2: { fontStyle:'bold', fillColor:[237,242,255], cellWidth:40 },
      },
      theme: 'grid',
    });
    y = doc.lastAutoTable.finalY + 8;

    // ── Premium & CTC GMC Calculation
    doc.setFontSize(10); doc.setFont('helvetica','bold');
    doc.text('Premium & CTC GMC Calculation', M, y); y += 5;
    doc.autoTable({
      startY: y, margin: { left:M, right:M },
      head: [['Description', 'Basis / Note', 'Amount']],
      body: [
        ['Total FF Premium (All Insured Members)',
          `Policy 24 Jul 2025-${policyEndLabel}, pro-rated to exit date`,
          fmtPDF(c.totalPremiumFF)],
        ['CTC GMC Per Month (Latest Increment)',
          'From latest increment record',
          fmtPDF(c.latestCtcGmc)],
        ['Total CTC GMC Available',
          'GMC FY Aug-Jul, up to last working day',
          fmtPDF(c.totalCtcGmc)],
        ['Opening Balance (2024-25 Carry Forward)',
          'Previous year closing balance',
          fmtPDF(c.openingBalance)],
        ['Total EMI Recovered via Salary',
          'Payroll deductions till exit',
          fmtPDF(c.totalDeducted)],
        ['NET POSITION',
          'CTC GMC + Opening Bal + EMI Recovered - FF Premium',
          fmtPDF(c.finalAmount)],
      ],
      styles:     { fontSize:8.5, cellPadding:2.5 },
      headStyles: { fillColor:[29,78,216], textColor:255, fontStyle:'bold' },
      columnStyles: { 2: { halign:'right', fontStyle:'bold' } },
      alternateRowStyles: { fillColor:[243,246,255] },
      didParseCell(data) {
        if (data.row.index === 5) {
          data.cell.styles.fontStyle  = 'bold';
          data.cell.styles.fillColor  = [235,240,255];
          data.cell.styles.fontSize   = 9.5;
          if (data.column.index === 2) {
            data.cell.styles.textColor = isRefund ? [6,95,70] : isRecovery ? [185,28,28] : [30,41,59];
          }
        }
      },
      theme: 'grid',
    });
    y = doc.lastAutoTable.finalY + 8;

    // ── Insured Family Members
    if (y > 200) { doc.addPage(); y = 18; }
    doc.setFontSize(10); doc.setFont('helvetica','bold');
    doc.text('Insured Family Members', M, y); y += 5;
    const membersBody = [
      [c.empName, 'Self', fmtDate(c.dob), fmtPDF(c.sumInsured), 'Active',
       '24 Jul 2025 - '+fmtDate(c.lwDay)],
      ...c.nonSelfDeps.map(d=>[
        d.insured_name||'—',
        d.relationship||'—',
        fmtDate(d.date_of_birth),
        fmtPDF(d.sum_insured),
        d.status==='A'||d.status==='Active' ? 'Active' : 'Inactive',
        (fmtDate(d.policy_start_date)||'24 Jul 2025') + ' - ' + policyEndLabel,
      ]),
    ];
    doc.autoTable({
      startY: y, margin: { left:M, right:M },
      head: [['Name','Relationship','DOB','Sum Insured','Status','Policy Period']],
      body: membersBody,
      styles:     { fontSize:8, cellPadding:2.2 },
      headStyles: { fillColor:[29,78,216], textColor:255, fontStyle:'bold' },
      alternateRowStyles: { fillColor:[243,246,255] },
      theme: 'grid',
    });
    y = doc.lastAutoTable.finalY + 8;

    // ── Payroll Deduction History
    if (c.deductions.length > 0) {
      if (y > 220) { doc.addPage(); y = 18; }
      doc.setFontSize(10); doc.setFont('helvetica','bold');
      doc.text('Payroll Deduction History', M, y); y += 5;
      // ✅ FIX: Group by payroll_month — prevents duplicate rows in PDF
      const dedGrouped = Object.values(
        c.deductions.reduce((acc, d) => {
          const key = d.payroll_month;
          if (!acc[key]) acc[key] = { payroll_month: key, deducted_amount: 0, remarks: [] };
          acc[key].deducted_amount += Number(d.deducted_amount || 0);
          const r = (d.remarks || '').trim();
          if (r && r.toLowerCase() !== 'nil') acc[key].remarks.push(r);
          return acc;
        }, {})
      ).sort((a,b) => a.payroll_month.localeCompare(b.payroll_month));
      const dedTotal = dedGrouped.reduce((s,d) => s + d.deducted_amount, 0);
      const dedBody = dedGrouped.map(d=>[
        d.payroll_month||'—',
        fmtPDF(d.deducted_amount),
      ]);
      dedBody.push(['TOTAL ('+dedGrouped.length+' month'+(dedGrouped.length!==1?'s':'')+' )', fmtPDF(dedTotal)]);
      doc.autoTable({
        startY: y, margin: { left:M, right:M },
        head: [['Payroll Month','Deducted Amount']],
        body: dedBody,
        styles:     { fontSize:8.5, cellPadding:2.5 },
        headStyles: { fillColor:[29,78,216], textColor:255, fontStyle:'bold' },
        columnStyles: { 1: { halign:'right', fontStyle:'bold' } },
        alternateRowStyles: { fillColor:[243,246,255] },
        didParseCell(data) {
          if (data.row.index === dedBody.length - 1) {
            data.cell.styles.fontStyle  = 'bold';
            data.cell.styles.fillColor  = [220,230,255];
          }
        },
        theme: 'grid',
      });
      y = doc.lastAutoTable.finalY + 10;
    }

    // ── Final Settlement Band
    if (y > 240) { doc.addPage(); y = 18; }
    doc.setFillColor(...bandColor);
    doc.rect(M, y, W-2*M, 24, 'F');
    doc.setFont('helvetica','bold'); doc.setTextColor(255,255,255); doc.setFontSize(11);
    doc.text(c.finalWording, M+5, y+9);
    doc.setFontSize(15);
    doc.text(fmtPDF(absAmt), W-M-3, y+9, { align:'right' });
    doc.setFontSize(8); doc.setFont('helvetica','normal'); doc.setTextColor(210,235,210);
    doc.text(numToWords(absAmt), M+5, y+19);
    y += 32;

    // ── Signatures
    if (y > 255) { doc.addPage(); y = 18; }
    doc.setTextColor(100,116,139); doc.setDrawColor(180,195,220);
    [M, 84, 154].forEach(x => doc.line(x, y+18, x+56, y+18));
    doc.setFontSize(8); doc.setFont('helvetica','normal');
    doc.text('HR / Authorised Signatory', M,   y+23);
    doc.text('Employee Acknowledgement',  84,  y+23);
    doc.text('Date',                      154, y+23);
    y += 30;
    doc.setFontSize(7);
    doc.text(
      'Generated: '+new Date().toLocaleString('en-IN')+
      '  |  gcpl.insurance-portal.in  |  naveen.paun@globalcalciumpharma.com',
      M, y
    );

    doc.save(`FF_GMC_Statement_${c.empId}_${new Date().toISOString().slice(0,10)}.pdf`);
    showToast('PDF downloaded!', 'success');
  } catch(e) {
    console.error(e);
    showToast('PDF error: '+e.message, 'error');
  }
}

// ─── Expose globally ──────────────────────────────────────────────────────────
window.renderFFStatementPage = renderFFStatementPage;
window.loadFFData            = loadFFData;
window.saveExitData          = saveExitData;
window.generateFFStatement   = generateFFStatement;
window.downloadFFPDF         = downloadFFPDF;

// ─── Patch navigate() to include ff_statement ────────────────────────────────
function navigate(page) {
  state.currentPage = page;
  state.page = 0; state.search = ''; state.empFilter = ''; state.searchAllRows = null;

  document.querySelectorAll('.sidebar-item').forEach(el => {
    el.classList.toggle('active', el.dataset.page === page);
  });

  const titles = {
    dashboard: 'Dashboard', employee_dashboard: 'My Dashboard',
    views: 'Database Views', emp_full_view: 'Employee Full View',
    user_management: 'User Management', concerns: 'Correction Concerns',
    ff_statement: 'F&F GMC Statement',
    gmc_renewal: 'GMC Renewal 2026-27',
    admin_renewal_progress: 'Renewal Progress 2026-27',
    ...Object.fromEntries(Object.entries(TABLES).map(([k,v]) => [k, v.label])),
  };
  document.getElementById('topbar-section').textContent = titles[page] || page;
  renderPageV2(page);
}

async function renderPageV2(page) {
  if (page === 'dashboard')          { await renderDashboard(); return; }
  if (page === 'employee_dashboard') { await renderEmployeeDashboardV2(); return; }
  if (page === 'views')              { renderViewsPage(); return; }
  if (page === 'emp_full_view')      { renderEmpFullView(); return; }
  if (page === 'user_management')    { await renderUserManagement(); return; }
  if (page === 'concerns')           { await renderConcernsPage(); return; }
  if (page === 'gmc_enrollment_form'){ await renderEnrollmentForm(); return; }
  if (page === 'admin_enrollments')  { await renderAdminEnrollments(); return; }
  if (page === 'ff_statement')       { await renderFFStatementPage(); return; }
  if (page === 'gmc_renewal')             { await renderRenewalPage(); return; }
  if (page === 'admin_renewal_progress')  { await renderAdminRenewalProgress(); return; }
  if (TABLES[page])                  { await renderTable(page); return; }
}

window.navigate    = navigate;
window.renderPageV2 = renderPageV2;

// ─── Fix sidebar visibility — full reset then role-based show/hide ───────────
// Override initApp to guarantee a clean slate on every login/session restore.
// Previously only hid elements; if a user changed roles between sessions the
// old visibility state leaked through. Now we reset ALL elements to visible
// first, then hide what this role should not see.
function initApp() {
  document.getElementById('login-page').style.display = 'none';
  // BUGFIX: showSetPasswordPage() sets an inline display:none on #app which
  // overrides the .visible class → blank page after forgot-password reset.
  // Clear the inline style and hide the set-password page before showing app.
  const appEl = document.getElementById('app');
  appEl.style.display = '';
  appEl.classList.add('visible');
  const setPwdPage = document.getElementById('set-password-page');
  if (setPwdPage) setPwdPage.style.display = 'none';

  const role = state.role || 'employee';

  // ── Topbar badge ──────────────────────────────────────────────────────────
  const badge = document.getElementById('topbar-badge');
  const roleIcons = { admin: '👑', hr: '🧑‍💼', employee: '🏷️' };
  const roleLabels = { admin: 'Admin', hr: 'HR', employee: 'Employee' };
  badge.className = 'topbar-badge ' + role;
  badge.innerHTML = (roleIcons[role] || '👤') + ' ' + (roleLabels[role] || role.toUpperCase());
  document.getElementById('topbar-user').textContent = state.userName || state.user?.email || '';

  // ── Step 1: Reset ALL sidebar items to visible ────────────────────────────
  // This ensures no stale hide state from a previous role/session.
  document.querySelectorAll('[data-admin-only]').forEach(el => el.style.display = '');
  document.querySelectorAll('[data-employee-only]').forEach(el => el.style.display = '');
  document.getElementById('admin-section').style.display = 'none'; // default hidden; shown for admin below

  // ── Step 2: Hide items that don't belong to this role ─────────────────────
  if (role === 'employee') {
    // Employees see ONLY their own My Insurance section and Support
    document.querySelectorAll('[data-admin-only]').forEach(el => el.style.display = 'none');
    // Employee-only items already visible — nothing more to hide
  } else {
    // HR and Admin: hide employee self-service items
    document.querySelectorAll('[data-employee-only]').forEach(el => el.style.display = 'none');

    if (role === 'admin') {
      // Admin gets user management section
      document.getElementById('admin-section').style.display = 'block';
    }
    // HR sees all admin-only data/analytics items but NOT user management
    // (admin-section stays hidden for hr)
  }

  // ── Navigate to role's home page ──────────────────────────────────────────
  const homePage = role === 'employee' ? 'employee_dashboard' : 'dashboard';
  navigate(homePage);
}
window.initApp = initApp;

// ─── Employee nav gating: Enrollment vs Renewal ──────────────────────────────
// Rule (per business spec):
//   • gmc_inclusion_date NULL            → not eligible → hide BOTH
//   • in insurance_dependents (existing) → Renewal only → hide Enrollment
//   • else (eligible new joinee)         → Enrollment only → hide Renewal
// Toggles both the sidebar items and the mobile bottom-nav buttons (both carry data-page).
function applyRenewalNavGating(eligible, isExisting) {
  if (state.role !== 'employee') return;
  const setShown = (page, shown) =>
    document.querySelectorAll(`[data-page="${page}"]`).forEach(el => { el.style.display = shown ? '' : 'none'; });

  if (!eligible) {
    setShown('gmc_enrollment_form', false);
    setShown('gmc_renewal', false);
  } else if (isExisting) {
    setShown('gmc_enrollment_form', false);
    setShown('gmc_renewal', true);
  } else {
    setShown('gmc_enrollment_form', true);
    setShown('gmc_renewal', false);
  }
}
window.applyRenewalNavGating = applyRenewalNavGating;

// ═══════════════════════════════════════════════════════════════════════════════
// ─── GMC RENEWAL 2026-27 — Employee renewal flow ─────────────────────────────
// 3-step wizard. Page 3 has Sum Insured selection ON TOP and Dependents BELOW.
// ═══════════════════════════════════════════════════════════════════════════════

const renewalState = {
  step: 1,                       // 1, 2, 3
  termsAccepted: false,
  eligibility: null,
  dependents: [],
  selectedSI: null,
  quote: null,
  submitting: false,
  validationErrors: [],          // ✅ FIX: tracks missing mobile/email from backend
};

function rFmt(v) {
  if (v == null || isNaN(Number(v))) return '—';
  return '₹' + Math.round(Number(v)).toLocaleString('en-IN');
}
function rFmtDate(s) {
  if (!s) return '—';
  try { const d = new Date(s); return d.toLocaleDateString('en-IN'); } catch { return s; }
}

async function renderRenewalPage() {
  const c = document.getElementById('content');
  c.innerHTML = `<div class="loading"><div class="spinner"></div> Loading renewal…</div>`;

  let elig;
  try { elig = await renewal.eligibility(); }
  catch (e) { c.innerHTML = `<div class="empty-state"><div class="icon">⚠️</div>${e.message}</div>`; return; }

  // ✅ FIX: Debug log window status
  console.log('[renewal] Backend response - window status:', {
    is_open: elig.window?.is_open,
    window_data: elig.window,
    eligible: elig.eligible,
  });

  renewalState.eligibility = elig;

  if (!elig.eligible) {
    const reason = elig.reason === 'NO_GMC_INCLUSION_DATE'
      ? 'GMC inclusion date is not set on your record.'
      : elig.reason === 'INACTIVE' ? 'Your record is marked inactive.'
      : 'You are not currently eligible for this renewal cycle.';
    c.innerHTML = `<div class="empty-state">
      <div class="icon">🚫</div>
      <b>Not eligible for GMC Renewal 2026-27</b><br>
      <div style="margin-top:8px;color:var(--text2)">${reason}</div>
      <div style="margin-top:12px;font-size:13px">If you believe this is an error, please contact HR.</div>
    </div>`;
    return;
  }

  // Already submitted? Show confirmation screen.
  if (elig.existing_renewal) {
    return renderRenewalAlreadySubmitted(elig);
  }

  // Parse dates safely — use local midnight so IST dates don't shift
  const parseDate = (dateStr) => {
    if (!dateStr) return new Date('2026-07-15T23:59:59');
    // If it's a plain date string (YYYY-MM-DD), append end-of-day so timezone doesn't flip it to yesterday
    const s = /^\d{4}-\d{2}-\d{2}$/.test(dateStr) ? dateStr + 'T23:59:59' : dateStr;
    const d = new Date(s);
    return isNaN(d.getTime()) ? new Date('2026-07-15T23:59:59') : d;
  };

  const openDate  = parseDate(elig.window?.open_at);
  const closeDate = parseDate(elig.window?.close_at);
  const now = new Date();

  // Format dates safely
  const formatDate = (d) => {
    if (!d || isNaN(d.getTime())) return 'July 15, 2026';
    return d.toLocaleDateString('en-IN');
  };

  // Trust the backend is_open flag as the single source of truth.
  // Only block employees when the backend explicitly says closed AND we are outside the date window.
  // This prevents a stale cache or slow startup from locking employees out.
  const backendSaysOpen  = elig.window?.is_open === true;
  const withinDateWindow = now <= closeDate; // past open_date is always true today; just guard deadline
  const effectiveIsOpen  = backendSaysOpen || withinDateWindow;

  console.log('[renewal] Window check:', {
    is_open: elig.window?.is_open,
    open_at: elig.window?.open_at,
    close_at: elig.window?.close_at,
    withinDateWindow,
    effectiveIsOpen,
  });

  if (!effectiveIsOpen && state.role === 'employee') {
    const isFuture = now < openDate;
    
    console.warn('[renewal] Window is not open:', {
      isFuture,
      message: isFuture ? 'window has not opened yet' : 'window has closed',
      backend_is_open: elig.window?.is_open,
    });
    
    c.innerHTML = `<div class="empty-state">
      <div class="icon">${isFuture ? '⏳' : '🔒'}</div>
      <b>Renewal window ${isFuture ? 'has not opened yet' : 'has closed'}</b><br>
      <div style="margin-top:8px;color:var(--text2)">
        Window: ${formatDate(openDate)} — ${formatDate(closeDate)}
      </div>
      <div style="margin-top:12px;font-size:12px;color:var(--text3)">
        If you believe this is an error, contact HR.
      </div>
    </div>`;
    return;
  }

  // Load dependents
  try {
    const dRes = await renewal.dependents(elig.employee.emp_id);
    renewalState.dependents = dRes.data || [];
  } catch (e) {
    renewalState.dependents = [];
    console.warn('[renewal] dependents fetch failed:', e.message);
  }

  // ✅ FIX: Store validation errors returned by backend (missing mobile/email)
  renewalState.validationErrors = elig.validation_errors || [];

  // Default SI = first available (= current SI, since lower options are filtered out)
  if (!renewalState.selectedSI) {
    renewalState.selectedSI = elig.current_sum_insured;
  }

  renderRenewalStep();
}

function renderRenewalStep() {
  const c = document.getElementById('content');
  const step = renewalState.step;
  c.innerHTML = `
    <div style="max-width:980px;margin:0 auto">
      ${renderRenewalStepper(step)}
      ${step === 1 ? renderRenewalStep1() : ''}
      ${step === 2 ? renderRenewalStep2() : ''}
      ${step === 3 ? renderRenewalStep3() : ''}
    </div>
  `;

  if (step === 3) {
    // Compute quote on render
    refreshRenewalQuote();
  }
}

function renderRenewalStepper(step) {
  const steps = [
    { n: 1, label: 'Terms & Conditions' },
    { n: 2, label: 'Verify Your Details' },
    { n: 3, label: 'Sum Insured · Dependents · Summary' },
  ];
  return `
    <div style="display:flex;gap:8px;margin-bottom:20px;flex-wrap:wrap">
      ${steps.map(s => `
        <div style="flex:1;min-width:180px;padding:12px;border-radius:10px;border:1px solid var(--border);
                    background:${s.n === step ? '#dbeafe' : s.n < step ? '#dcfce7' : 'white'};
                    color:${s.n === step ? '#1e40af' : s.n < step ? '#15803d' : 'var(--text2)'};font-size:13px">
          <div style="font-weight:700">${s.n < step ? '✅' : s.n === step ? '➜' : '○'} Step ${s.n}</div>
          <div>${s.label}</div>
        </div>
      `).join('')}
    </div>
  `;
}

// ─── Step 1: Terms & Conditions ─────────────────────────────────────────────
function renderRenewalStep1() {
  // ✅ Get dynamic window dates from eligibility data instead of hardcoding
  const parseDate = (dateStr) => {
    if (!dateStr) return new Date('2026-07-15');
    const d = new Date(dateStr);
    return isNaN(d.getTime()) ? new Date('2026-07-15') : d;
  };
  
  const formatDate = (d) => {
    if (!d || isNaN(d.getTime())) return 'July 15, 2026';
    return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' });
  };
  
  const openDate = formatDate(parseDate(renewalState.eligibility?.window?.open_at));
  const closeDate = formatDate(parseDate(renewalState.eligibility?.window?.close_at));
  
  return `
    <div style="background:white;border:1px solid var(--border);border-radius:14px;padding:24px">
      <h2 style="margin:0 0 12px 0">📋 GMC Renewal 2026-27 — Terms & Conditions</h2>
      <div style="background:#fef3c7;border-left:4px solid #f59e0b;padding:12px;border-radius:8px;margin-bottom:16px;font-size:13px">
        <b>Renewal Window:</b> ${openDate} — ${closeDate}.
        <div style="margin-top:8px;color:#92400e">
          <b>Important:</b> If you do <b>not</b> submit this renewal, your last year's data will be carried
          forward <b>as-is with no changes</b>. <b>No change requests will be accepted after the window closes.</b>
        </div>
      </div>
      <div style="font-size:14px;line-height:1.7;color:var(--text2);max-height:340px;overflow-y:auto;
                   padding:16px;background:var(--surface2);border-radius:10px">
        <ol style="padding-left:18px">
          <li><b>Coverage period:</b> 24 July 2026 to 23 July 2027.</li>
          <li><b>Adding members is limited.</b> You may add a <b>newborn</b> (within 30 days of birth) or a
            <b>newly-married spouse</b> (within 30 days of marriage). Other family members not currently
            enrolled cannot be added. You may DELETE a dependent with a reason (expired / not continuing);
            <b>once deleted, the dependent cannot be re-added in future renewals.</b></li>
          <li>You may correct typos in dependent <b>name, date of birth, and gender</b>. The <b>relation</b> field is locked.</li>
          <li><b>Sum Insured</b> can be increased or kept the same. <b>It cannot be decreased.</b></li>
          <li>Premium displayed is approximate and may vary <b>±10%</b> based on the insurer's final policy booking.</li>
          <li>If 26-27 premium exceeds your available CTC GMC + 25-26 closing balance, the shortfall will be recovered as a 6-month salary deduction starting <b>September 2026</b>.</li>
          <li>25-26 closing balance (excess over premium) will be refunded in <b>September 2026</b>, considering the 26-27 premium.</li>
          <li>26-27 closing balance will be settled in <b>September 2027</b> (subject to 2027-28 increment and enrollment).</li>
          <li>All details submitted are deemed correct on submission. Corrections after submission require an HR endorsement.</li>
          <li>By submitting, you authorise GCPL to share your details and dependents' details with the insurer for policy issuance.</li>
        </ol>
      </div>
      <div style="margin-top:16px;display:flex;align-items:center;gap:10px;font-size:14px">
        <input type="checkbox" id="renewal-terms-cb" ${renewalState.termsAccepted ? 'checked' : ''}
          onchange="renewalState.termsAccepted = this.checked; document.getElementById('renewal-next-1').disabled = !this.checked;"
          style="width:18px;height:18px;cursor:pointer">
        <label for="renewal-terms-cb" style="cursor:pointer">I have read and accept the terms and conditions above.</label>
      </div>
      <div style="margin-top:20px;display:flex;justify-content:flex-end">
        <button id="renewal-next-1" class="btn btn-primary" onclick="renewalGoStep(2)"
          ${renewalState.termsAccepted ? '' : 'disabled'}>Continue to Step 2 →</button>
      </div>
    </div>
  `;
}

// ─── Step 2: Verify employee details ─────────────────────────────────────────
function renderRenewalStep2() {
  const e    = renewalState.eligibility.employee || {};
  const calc = renewalState.eligibility.calc || {};

  // If mobile is missing, let the employee add it right here.
  const mobileWarning = !e.mobile_number ? `
    <div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:10px;padding:12px 14px;margin-bottom:14px;color:#9a3412;font-size:13px">
      <div style="display:flex;gap:10px;align-items:flex-start;margin-bottom:10px">
        <span style="font-size:18px;line-height:1">📱</span>
        <div><b>Add your mobile number.</b> It's used by the insurer and for renewal updates.</div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <input id="renewal-mobile-input" type="tel" maxlength="10" inputmode="numeric" placeholder="10-digit mobile"
          style="flex:1;min-width:180px;padding:9px 12px;border:1px solid #fdba74;border-radius:8px;font-size:14px">
        <button class="btn btn-primary btn-sm" onclick="renewalSaveMobile()">Save mobile</button>
      </div>
    </div>` : '';

  const emailWarning = !e.email_id ? `
    <div style="background:#fecaca;border:1px solid #fca5a5;border-radius:10px;padding:12px 14px;margin-bottom:14px;color:#991b1b;font-size:13px;display:flex;gap:10px;align-items:flex-start">
      <span style="font-size:18px;line-height:1">⚠️</span>
      <div>
        <b>Email ID is missing from your employee record.</b>
        This is required to submit your renewal. Please
        <button onclick="navigate('concerns')" style="background:none;border:none;color:#991b1b;text-decoration:underline;cursor:pointer;font-size:inherit;padding:0;font-weight:600">raise a concern to HR</button>
        to update it before proceeding.
      </div>
    </div>` : '';

  return `
    <div style="background:white;border:1px solid var(--border);border-radius:14px;padding:24px">
      <h2 style="margin:0 0 12px 0">👤 Verify Your Details</h2>
      <div style="font-size:13px;color:var(--text2);margin-bottom:16px">
        Please verify the details below. If anything is wrong, raise a Correction Concern from the sidebar before submitting.
      </div>
      ${mobileWarning}${emailWarning}
      <div class="form-grid">
        <div class="detail-item"><span class="detail-key">Employee ID</span><span class="detail-val"><code>${e.emp_id || '—'}</code></span></div>
        <div class="detail-item"><span class="detail-key">Name</span><span class="detail-val">${e.emp_name || '—'}</span></div>
        <div class="detail-item"><span class="detail-key">Date of Birth</span><span class="detail-val">${rFmtDate(e.date_of_birth)}</span></div>
        <div class="detail-item"><span class="detail-key">Designation</span><span class="detail-val">${e.designation || '—'}</span></div>
        <div class="detail-item"><span class="detail-key">Department</span><span class="detail-val">${e.department || '—'}</span></div>
        <div class="detail-item"><span class="detail-key">Unit</span><span class="detail-val">${e.unit || '—'}</span></div>
        <div class="detail-item"><span class="detail-key">GMC Inclusion Date</span><span class="detail-val">${rFmtDate(e.gmc_inclusion_date)}</span></div>
        <div class="detail-item"><span class="detail-key">Current CTC GMC / month</span><span class="detail-val">${rFmt(e.ctc_gmc_per_month)}</span></div>
        <div class="detail-item"><span class="detail-key">Email</span>
          <span class="detail-val" style="font-size:12px${!e.email_id ? ';color:#b91c1c;font-weight:600' : ''}">
            ${e.email_id || '⚠️ Missing'}
          </span>
        </div>
        <div class="detail-item"><span class="detail-key">Mobile</span>
          <span class="detail-val${!e.mobile_number ? '" style="color:#b91c1c;font-weight:600' : ''}">
            ${e.mobile_number || '⚠️ Missing'}
          </span>
        </div>
        <div class="detail-item"><span class="detail-key">Current Sum Insured</span><span class="detail-val"><b>${rFmt(renewalState.eligibility.current_sum_insured)}</b></span></div>
      </div>

      <div style="margin-top:20px;padding:14px;background:#eff6ff;border-radius:10px;font-size:13px;color:#1e3a8a">
        <b>📊 Your 25-26 figures (for reference)</b>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;margin-top:8px">
          <div>CTC GMC 25-26: <b>${rFmt(calc.ctc_gmc_25_26)}</b></div>
          <div>Opening Balance: <b>${rFmt(calc.opening_balance_25_26)}</b></div>
          <div>Salary Deductions: <b>${rFmt(calc.salary_deductions_25_26)}</b></div>
          <div>Premium 25-26: <b>${rFmt(calc.premium_25_26)}</b></div>
          <div style="grid-column:1/-1;border-top:1px solid #93c5fd;padding-top:6px;margin-top:4px">
            25-26 Closing Balance: <b style="color:${(calc.closing_balance_25_26 || 0) >= 0 ? '#15803d' : '#b91c1c'}">${rFmt(calc.closing_balance_25_26)}</b>
            <span style="color:#1e3a8a">(${(calc.closing_balance_25_26 || 0) >= 0 ? 'refundable / carry forward' : 'recovery'})</span>
          </div>
        </div>
      </div>

      <div style="margin-top:20px;display:flex;justify-content:space-between">
        <button class="btn btn-secondary" onclick="renewalGoStep(1)">← Back</button>
        <button class="btn btn-primary" onclick="renewalGoStep(3)">Continue to Step 3 →</button>
      </div>
    </div>
  `;
}

// ─── Step 3: Sum Insured (top) + Dependents (below) + Summary ────────────────
function renderRenewalStep3() {
  const elig    = renewalState.eligibility;
  const options = elig.available_sum_insured || [];
  const current = elig.current_sum_insured;
  const deps    = Array.isArray(renewalState.dependents) ? renewalState.dependents : [];

  return `
    <div style="background:white;border:1px solid var(--border);border-radius:14px;padding:24px">
      <h2 style="margin:0 0 12px 0">📝 Renewal — Sum Insured, Dependents & Summary</h2>

      <!-- ① Sum Insured on top -->
      <div style="padding:16px;background:var(--surface2);border-radius:12px;margin-bottom:20px">
        <div style="font-weight:700;font-size:14px;margin-bottom:10px">① Sum Insured (Family Floater)</div>
        <div style="font-size:13px;color:var(--text2);margin-bottom:10px">
          Current: <b>${rFmt(current)}</b> · You may increase or keep the same; <b>decrease is not allowed.</b>
        </div>
        <select id="renewal-si-select" onchange="renewalState.selectedSI = Number(this.value); refreshRenewalQuote();"
          style="width:100%;max-width:340px;padding:10px;border:1px solid var(--border);border-radius:8px;font-size:14px;font-weight:600">
          ${options.map(si => `<option value="${si}" ${si === renewalState.selectedSI ? 'selected' : ''}>${rFmt(si)}${si === current ? '  (current)' : ''}</option>`).join('')}
        </select>
      </div>

      <!-- ② Dependents -->
      <div style="padding:16px;background:var(--surface2);border-radius:12px;margin-bottom:20px">
        <div style="font-weight:700;font-size:14px;margin-bottom:10px">② Dependents</div>
        <div style="font-size:13px;color:var(--text2);margin-bottom:12px">
          You can <b>edit name/DOB/gender</b> or <b>delete</b> existing dependents.
          New members can be added <b>only</b> for a <b>newborn</b> (within 30 days of birth) or a
          <b>newly-married spouse</b> (within 30 days of marriage).
          Once you delete a dependent and submit, they cannot be re-added in future renewals.
        </div>
        ${(() => {
          const hasSpouse = deps.some(d => d.relation === 'Spouse' && d.action !== 'DELETE');
          return `
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">
            <button class="btn btn-secondary btn-sm" onclick="renewalAddDependent('NEWBORN')">👶 Add Newborn</button>
            ${hasSpouse ? '' : `<button class="btn btn-secondary btn-sm" onclick="renewalAddDependent('NEW_SPOUSE')">💍 Add New Spouse</button>`}
            <span style="font-size:12px;color:var(--text3);align-self:center">Marital status:
              <b>${hasSpouse ? 'Married' : (renewalState.eligibility?.employee?.marital_status || '—')}</b></span>
          </div>`;
        })()}
        ${deps.length === 0
          ? `<div style="padding:20px;text-align:center;color:var(--text3);background:white;border-radius:8px">No dependents on record for this renewal.</div>`
          : `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px">
              ${deps.map(d => renderRenewalDepCard(d)).join('')}
            </div>`
        }
      </div>

      <!-- ③ Live Summary -->
      <div id="renewal-summary" style="padding:16px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:12px;margin-bottom:20px">
        <div class="loading"><div class="spinner"></div> Calculating premium…</div>
      </div>

      <!-- Submit -->
      <div style="padding:14px;background:#fff7ed;border-left:4px solid #f59e0b;border-radius:8px;margin-bottom:16px;font-size:13px">
        ⚠️ Premium shown is <b>approximate</b> and may vary <b>±10%</b> based on the insurer's final policy booking.<br>
        Sep-27 refund is an <b>estimate</b> and depends on 2027-28 increment & enrollment.
      </div>

      <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap">
        <button class="btn btn-secondary" onclick="renewalGoStep(2)">← Back</button>
        ${(() => {
          const e = renewalState.eligibility.employee || {};
          const missingContact = !e.mobile_number || !e.email_id;
          const tip = missingContact
            ? 'Mobile/email is missing from your record — submission still works, but please ask HR to update it.'
            : '';
          return `<button id="renewal-submit-btn" class="btn btn-primary"
            onclick="submitRenewal()"
            title="${tip}">
            ✅ Submit Renewal
          </button>`;
        })()}
      </div>
    </div>
  `;
}

function renderRenewalDepCard(d) {
  const isDelete = d.action === 'DELETE';
  const relIcons = { Spouse:'💑', Son:'👦', Daughter:'👧', Father:'👨', Mother:'👩', 'Father-in-Law':'👴', 'Mother-in-Law':'👵' };
  return `
    <div style="background:white;border:1px solid ${isDelete ? '#fca5a5' : 'var(--border)'};border-radius:10px;padding:12px;
                ${isDelete ? 'opacity:0.7' : ''}">
      <div style="display:flex;justify-content:space-between;align-items:start;gap:8px">
        <div style="font-size:24px">${relIcons[d.relation] || '👤'}</div>
        <div style="flex:1">
          <div style="font-weight:700;font-size:14px;${isDelete ? 'text-decoration:line-through' : ''}">${d.dependent_name}</div>
          <div style="font-size:12px;color:var(--text2)"><b>${d.relation}</b> · DOB: ${rFmtDate(d.date_of_birth)}${d.gender ? ' · ' + d.gender : ''}</div>
          ${d.edited ? '<div style="font-size:11px;color:#1e40af;margin-top:2px">✏️ edited</div>' : ''}
          ${isDelete ? `<div style="font-size:11px;color:#b91c1c;margin-top:4px;font-weight:700">🗑️ Marked for deletion (${d.delete_reason === 'EXPIRED' ? 'Expired' : 'Not Continuing'})</div>` : ''}
        </div>
      </div>
      <div style="margin-top:10px;display:flex;gap:6px;flex-wrap:wrap">
        ${isDelete
          ? `<button class="btn btn-secondary btn-sm" onclick="renewalRestoreDep(${d.id})">↩ Restore</button>`
          : `<button class="btn btn-secondary btn-sm" onclick="renewalEditDep(${d.id})">✏️ Edit</button>
             <button class="btn btn-danger btn-sm"    onclick="renewalDeleteDep(${d.id})">🗑️ Delete</button>`
        }
      </div>
    </div>
  `;
}

// ─── Step navigation ─────────────────────────────────────────────────────────
function renewalGoStep(n) {
  if (n === 2 && !renewalState.termsAccepted) {
    showToast('Please accept the terms first', 'error'); return;
  }
  renewalState.step = n;
  renderRenewalStep();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ─── Quote refresh ────────────────────────────────────────────────────────────
async function refreshRenewalQuote() {
  const empId = renewalState.eligibility.employee.emp_id;
  const si    = renewalState.selectedSI;
  if (!si) return;

  const sum = document.getElementById('renewal-summary');
  if (sum) sum.innerHTML = `<div class="loading"><div class="spinner"></div> Calculating premium…</div>`;

  try {
    const q = await renewal.quote({ emp_id: empId, sum_insured: si });
    renewalState.quote = q;
    if (sum) sum.innerHTML = renderRenewalSummary(q);
  } catch (e) {
    if (sum) sum.innerHTML = `<div style="color:var(--danger)">❌ ${e.message}</div>`;
  }
}

function renderRenewalSummary(q) {
  // ✅ FIX: Defensive guard — members must be an array
  const members = Array.isArray(q.members) ? q.members : [];
  const negNet = (q.salary_deduction_26_27 || 0) > 0;
  return `
    <div style="font-weight:700;font-size:14px;margin-bottom:10px">③ Live Summary — Premium & Settlement</div>

    <div style="background:white;border-radius:8px;padding:12px;margin-bottom:10px">
      <div style="font-size:12px;color:var(--text2);margin-bottom:6px"><b>Insured Members (${members.length})</b></div>
      <table style="width:100%;font-size:13px;border-collapse:collapse">
        <thead><tr style="background:var(--surface2);text-align:left">
          <th style="padding:6px 8px">Name</th><th style="padding:6px 8px">Relation</th>
          <th style="padding:6px 8px">Age</th><th style="padding:6px 8px;text-align:right">Annual Premium</th>
        </tr></thead>
        <tbody>
          ${members.map(m => `<tr style="border-top:1px solid #e5e7eb">
            <td style="padding:6px 8px">${m.member_name}</td>
            <td style="padding:6px 8px">${m.relation}</td>
            <td style="padding:6px 8px">${m.age_at_policy_start}</td>
            <td style="padding:6px 8px;text-align:right">${rFmt(m.annual_premium)}</td>
          </tr>`).join('')}
        </tbody>
        <tfoot><tr style="font-weight:700;background:var(--surface2)">
          <td colspan="3" style="padding:6px 8px;text-align:right">Total Premium 26-27 (approx.)</td>
          <td style="padding:6px 8px;text-align:right">${rFmt(q.total_premium_26_27)}</td>
        </tr></tfoot>
      </table>
    </div>

    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px">
      <div style="background:white;border-radius:8px;padding:12px">
        <div style="font-size:11px;color:var(--text3)">26-27 CTC GMC Estimated</div>
        <div style="font-size:18px;font-weight:700">${rFmt(q.ctc_gmc_26_27)}</div>
      </div>
      <div style="background:white;border-radius:8px;padding:12px">
        <div style="font-size:11px;color:var(--text3)">25-26 Closing Balance</div>
        <div style="font-size:18px;font-weight:700;color:${(q.closing_balance_25_26||0)>=0?'#15803d':'#b91c1c'}">${rFmt(q.closing_balance_25_26)}</div>
      </div>
      <div style="background:white;border-radius:8px;padding:12px">
        <div style="font-size:11px;color:var(--text3)">Refund Sep-26 (25-26 settled)</div>
        <div style="font-size:18px;font-weight:700;color:#15803d">${rFmt(q.refund_sep_2026)}</div>
      </div>
      <div style="background:white;border-radius:8px;padding:12px">
        <div style="font-size:11px;color:var(--text3)">Refund Sep-27 Estimate (26-27)</div>
        <div style="font-size:18px;font-weight:700;color:#15803d">${rFmt(q.refund_sep_2027_estimate)}*</div>
      </div>
      ${negNet ? `
        <div style="grid-column:1/-1;background:#fef2f2;border:1px solid #fca5a5;border-radius:8px;padding:12px">
          <div style="font-size:11px;color:#991b1b">Salary Deduction 26-27 (6-month EMI from Sep 2026)</div>
          <div style="font-size:18px;font-weight:700;color:#b91c1c">
            ${rFmt(q.salary_deduction_26_27)}
            <span style="font-size:12px;font-weight:500;color:var(--text2)"> · EMI ₹${Math.round(q.emi_per_month_6mo).toLocaleString('en-IN')}/month × 6</span>
          </div>
        </div>` : ''
      }
    </div>
    <div style="font-size:11px;color:var(--text3);margin-top:8px">* Estimate subject to 27-28 increment & enrollment.</div>
  `;
}

// ─── Dependent actions ────────────────────────────────────────────────────────
async function renewalDeleteDep(id) {
  const d = renewalState.dependents.find(x => x.id === id);
  if (!d) return;
  const reason = await renewalAskDeleteReason(d);
  if (!reason) return;

  try {
    await renewal.deleteDependent(id, reason);
    d.action = 'DELETE'; d.delete_reason = reason;
    showToast('Dependent marked for deletion', 'success');
    renderRenewalStep();
  } catch (e) { showToast(e.message, 'error'); }
}

async function renewalRestoreDep(id) {
  try {
    await renewal.restoreDependent(id);
    const d = renewalState.dependents.find(x => x.id === id);
    if (d) { d.action = 'KEEP'; d.delete_reason = null; }
    showToast('Dependent restored', 'success');
    renderRenewalStep();
  } catch (e) { showToast(e.message, 'error'); }
}

function renewalAskDeleteReason(dep) {
  return new Promise(resolve => {
    const html = `
      <div style="position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:2000;
                  display:flex;align-items:center;justify-content:center;padding:20px" id="renewal-del-modal">
        <div style="background:white;border-radius:14px;padding:24px;max-width:480px;width:100%">
          <h3 style="margin:0 0 12px 0">🗑️ Delete ${dep.dependent_name}?</h3>
          <div style="background:#fef2f2;border-left:4px solid #dc2626;padding:12px;border-radius:8px;font-size:13px;margin-bottom:14px">
            <b>⚠️ Important:</b> Once you delete and submit, this dependent <b>cannot be re-added</b> in future renewals.
          </div>
          <div style="font-weight:600;font-size:13px;margin-bottom:8px">Reason for deletion:</div>
          <label style="display:flex;align-items:start;gap:10px;padding:10px;border:1px solid var(--border);border-radius:8px;cursor:pointer;margin-bottom:8px">
            <input type="radio" name="del-reason" value="EXPIRED">
            <div><b>Dependent is no longer alive</b><br><span style="font-size:12px;color:var(--text2)">Use this if the dependent has passed away.</span></div>
          </label>
          <label style="display:flex;align-items:start;gap:10px;padding:10px;border:1px solid var(--border);border-radius:8px;cursor:pointer">
            <input type="radio" name="del-reason" value="NOT_CONTINUING">
            <div><b>Do not want to continue coverage</b><br><span style="font-size:12px;color:var(--text2)">Use this if you do not want to cover this dependent going forward.</span></div>
          </label>
          <div style="margin-top:16px;display:flex;gap:10px;justify-content:flex-end">
            <button class="btn btn-secondary" id="rdm-cancel">Cancel</button>
            <button class="btn btn-danger"    id="rdm-confirm">Delete</button>
          </div>
        </div>
      </div>`;
    document.body.insertAdjacentHTML('beforeend', html);
    const modal = document.getElementById('renewal-del-modal');
    document.getElementById('rdm-cancel').onclick = () => { modal.remove(); resolve(null); };
    document.getElementById('rdm-confirm').onclick = () => {
      const sel = modal.querySelector('input[name="del-reason"]:checked');
      if (!sel) { showToast('Please pick a reason', 'error'); return; }
      modal.remove(); resolve(sel.value);
    };
  });
}

// ─── Save a missing mobile number from the renewal flow ──────────────────────
async function renewalSaveMobile() {
  const input = document.getElementById('renewal-mobile-input');
  const mobile = (input?.value || '').replace(/\D/g, '');
  if (mobile.length !== 10) return showToast('Enter a valid 10-digit mobile number', 'error');
  try {
    await renewal.updateContact({ mobile_number: mobile });
    if (renewalState.eligibility?.employee) renewalState.eligibility.employee.mobile_number = mobile;
    showToast('Mobile number saved', 'success');
    renderRenewalStep();
  } catch (e) { showToast(e.message, 'error'); }
}

// ─── Add a newborn / newly-married spouse ────────────────────────────────────
async function renewalAddDependent(type) {
  const empId = renewalState.eligibility.employee.emp_id;
  const isSpouse = type === 'NEW_SPOUSE';
  const title = isSpouse ? '💍 Add New Spouse' : '👶 Add Newborn';
  const note  = isSpouse
    ? 'Allowed only within <b>30 days of marriage</b>. Spouse must be at least 18 years old.'
    : 'Allowed only within <b>30 days of birth</b>.';

  const html = `
    <div style="position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:2000;
                display:flex;align-items:center;justify-content:center;padding:20px" id="renewal-add-modal">
      <div style="background:white;border-radius:14px;padding:24px;max-width:520px;width:100%">
        <h3 style="margin:0 0 8px 0">${title}</h3>
        <div style="background:#eff6ff;border-left:4px solid #3b82f6;padding:10px 12px;border-radius:8px;font-size:12px;color:#1e3a8a;margin-bottom:14px">${note}</div>
        <div class="form-grid">
          ${isSpouse ? '' : `
          <div class="form-group">
            <label>Relation *</label>
            <select id="rad-rel">
              <option value="Son">Son</option>
              <option value="Daughter">Daughter</option>
            </select>
          </div>`}
          <div class="form-group">
            <label>Name *</label>
            <input type="text" id="rad-name" placeholder="Full name">
          </div>
          <div class="form-group">
            <label>Date of Birth *</label>
            <input type="date" id="rad-dob">
          </div>
          <div class="form-group">
            <label>Gender</label>
            <select id="rad-gender">
              <option value="">—</option>
              <option value="Male">Male</option>
              <option value="Female">Female</option>
            </select>
          </div>
          ${isSpouse ? `
          <div class="form-group">
            <label>Marriage Date *</label>
            <input type="date" id="rad-marriage">
          </div>` : ''}
        </div>
        <div style="margin-top:16px;display:flex;gap:10px;justify-content:flex-end">
          <button class="btn btn-secondary" onclick="document.getElementById('renewal-add-modal').remove()">Cancel</button>
          <button class="btn btn-primary" id="rad-save">Add</button>
        </div>
      </div>
    </div>`;
  document.body.insertAdjacentHTML('beforeend', html);

  document.getElementById('rad-save').onclick = async () => {
    const name = document.getElementById('rad-name').value.trim();
    const dob  = document.getElementById('rad-dob').value.trim();
    const gen  = document.getElementById('rad-gender').value;
    if (!name) return showToast('Name is required', 'error');
    if (!dob)  return showToast('Date of birth is required', 'error');

    const body = { addition_type: type, insured_name: name, date_of_birth: dob, gender: gen || null };
    if (isSpouse) {
      const marriage = document.getElementById('rad-marriage').value.trim();
      if (!marriage) return showToast('Marriage date is required', 'error');
      body.relationship = 'Spouse';
      body.marriage_date = marriage;
    } else {
      body.relationship = document.getElementById('rad-rel').value;
    }

    try {
      await renewal.addDependent(empId, body);
      const dRes = await renewal.dependents(empId);
      renewalState.dependents = dRes.data || [];
      showToast(isSpouse ? 'Spouse added' : 'Newborn added', 'success');
      document.getElementById('renewal-add-modal').remove();
      renderRenewalStep();        // re-render Step 3 (also refreshes the quote)
    } catch (e) { showToast(e.message, 'error'); }
  };
}

async function renewalEditDep(id) {
  const d = renewalState.dependents.find(x => x.id === id);
  if (!d) return;
  const html = `
    <div style="position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:2000;
                display:flex;align-items:center;justify-content:center;padding:20px" id="renewal-edit-modal">
      <div style="background:white;border-radius:14px;padding:24px;max-width:520px;width:100%">
        <h3 style="margin:0 0 12px 0">✏️ Edit ${d.dependent_name}</h3>
        <div style="font-size:12px;color:var(--text2);margin-bottom:14px">
          You can fix typos in <b>name, DOB, or gender</b>. <b>Relation cannot be changed.</b>
        </div>
        <div class="form-grid">
          <div class="form-group">
            <label>Relation (locked)</label>
            <input type="text" value="${d.relation}" disabled style="background:var(--surface2)">
          </div>
          <div class="form-group">
            <label>Name *</label>
            <input type="text" id="red-name" value="${(d.dependent_name||'').replace(/"/g,'&quot;')}">
          </div>
          <div class="form-group">
            <label>Date of Birth *</label>
            <input type="date" id="red-dob" value="${d.date_of_birth || ''}">
          </div>
          <div class="form-group">
            <label>Gender</label>
            <select id="red-gender">
              <option value="">—</option>
              <option value="Male"   ${d.gender==='Male'?'selected':''}>Male</option>
              <option value="Female" ${d.gender==='Female'?'selected':''}>Female</option>
            </select>
          </div>
        </div>
        <div style="margin-top:16px;display:flex;gap:10px;justify-content:flex-end">
          <button class="btn btn-secondary" onclick="document.getElementById('renewal-edit-modal').remove()">Cancel</button>
          <button class="btn btn-primary"    id="red-save">Save</button>
        </div>
      </div>
    </div>`;
  document.body.insertAdjacentHTML('beforeend', html);
  document.getElementById('red-save').onclick = async () => {
    const name = document.getElementById('red-name').value.trim();
    const dob  = document.getElementById('red-dob').value.trim();
    const gen  = document.getElementById('red-gender').value;
    if (!name) return showToast('Name is required', 'error');
    if (!dob)  return showToast('DOB is required', 'error');
    try {
      await renewal.editDependent(id, { dependent_name: name, date_of_birth: dob, gender: gen || null });
      d.dependent_name = name; d.date_of_birth = dob; d.gender = gen; d.edited = true;
      showToast('Dependent updated', 'success');
      document.getElementById('renewal-edit-modal').remove();
      renderRenewalStep();
    } catch (e) { showToast(e.message, 'error'); }
  };
}

// ─── Submit ──────────────────────────────────────────────────────────────────
async function submitRenewal() {
  if (renewalState.submitting) return;
  const emp   = renewalState.eligibility.employee;
  const empId = emp.emp_id;
  const si    = renewalState.selectedSI;
  if (!si) return showToast('Please select Sum Insured', 'error');

  // Contact details preferred (for confirmation email) but not blocking.
  if (!emp.mobile_number || !emp.email_id) {
    const missing = [!emp.mobile_number && 'mobile number', !emp.email_id && 'email ID'].filter(Boolean).join(' and ');
    showToast(`⚠️ Your ${missing} is missing — submitting anyway. Please ask HR to update it.`, 'info');
  }

  if (!confirm('Submit your 2026-27 GMC Renewal? You will not be able to add deleted dependents back in future cycles.')) return;

  const btn = document.getElementById('renewal-submit-btn');
  renewalState.submitting = true;
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Submitting…'; }

  // ✅ FIX: Inner helper — attempt one submission call
  const attempt = async () => renewal.submit({ emp_id: empId, sum_insured: si, terms_accepted: true });

  try {
    const r = await attempt();
    showToast('✅ Renewal submitted!', 'success');
    renewalState.eligibility.existing_renewal = {
      enrollment_id: r.enrollment_id,
      enrollment_status: 'SUBMITTED',
      submitted_at: new Date().toISOString(),
    };
    renderRenewalAlreadySubmitted(renewalState.eligibility);
  } catch (e) {
    const msg = (e.message || '').toLowerCase();

    // ✅ FIX: Detect Render cold-start 500 — auto-retry once after 2 s
    if (msg.includes('500') || msg.includes('failed to load resource') || msg.includes('temporary')) {
      if (btn) btn.textContent = '⏳ Retrying…';
      showToast('⏳ Server is warming up — retrying in 2 seconds…', 'info');
      await new Promise(r => setTimeout(r, 2000));
      try {
        const r2 = await attempt();
        showToast('✅ Renewal submitted!', 'success');
        renewalState.eligibility.existing_renewal = {
          enrollment_id: r2.enrollment_id,
          enrollment_status: 'SUBMITTED',
          submitted_at: new Date().toISOString(),
        };
        renderRenewalAlreadySubmitted(renewalState.eligibility);
        return;                           // success on retry — exit before resetting btn
      } catch (e2) {
        const msg2 = (e2.message || '').toLowerCase();
        // If retry returns "already submitted" the first attempt actually succeeded
        if (msg2.includes('already submitted')) {
          showToast('✅ Renewal was already recorded successfully.', 'success');
          setTimeout(() => renderRenewalPage(), 1500);
          return;
        }
        showToast('❌ ' + e2.message, 'error');
      }
    }
    // Already submitted — first attempt silently succeeded despite the 500
    else if (msg.includes('already submitted')) {
      showToast('✅ Your renewal was already submitted successfully.', 'success');
      setTimeout(() => renderRenewalPage(), 1500);
      return;
    }
    // Validation error from backend (mobile / email)
    else if (msg.includes('mobile') || msg.includes('email') || msg.includes('validation')) {
      showToast('❌ Profile error: ' + e.message + '\nPlease contact HR.', 'error');
    }
    // Renewal window closed
    else if (msg.includes('window') || msg.includes('closed')) {
      showToast('❌ Renewal window has closed. ' + e.message, 'error');
    }
    else {
      showToast('❌ ' + e.message, 'error');
    }

    // Reset button for all non-success paths
    if (btn) { btn.disabled = false; btn.textContent = '✅ Submit Renewal'; }
  } finally {
    renewalState.submitting = false;
  }
}

function renderRenewalAlreadySubmitted(elig) {
  const c = document.getElementById('content');
  const r = elig.existing_renewal;
  c.innerHTML = `
    <div style="max-width:720px;margin:40px auto;background:white;border:1px solid var(--border);border-radius:14px;padding:32px;text-align:center">
      <div style="font-size:48px">✅</div>
      <h2 style="margin:10px 0">Renewal Submitted</h2>
      <div style="color:var(--text2);font-size:14px;margin-bottom:8px">
        Your GMC Renewal 2026-27 has been submitted on <b>${rFmtDate(r.submitted_at)}</b>.
      </div>
      <div style="color:var(--text2);font-size:13px;margin-bottom:16px">
        Enrollment ID: <code>#${r.enrollment_id}</code> · Status: <b>${r.enrollment_status}</b>
      </div>
      <div style="background:#eff6ff;padding:14px;border-radius:10px;font-size:13px;color:#1e3a8a;text-align:left">
        ✉️ A confirmation email with your insured members, premium estimate and settlement details has been sent to <b>${elig.employee.email_id}</b>.<br><br>
        ⚠️ Premium is approximate (±10%). Final amount will be confirmed after the insurer's policy booking.
      </div>
      <div style="margin-top:20px">
        <button class="btn btn-secondary" onclick="navigate('employee_dashboard')">← Back to Dashboard</button>
      </div>
    </div>
  `;
}

// Expose
window.renderRenewalPage    = renderRenewalPage;
window.renewalGoStep        = renewalGoStep;
window.refreshRenewalQuote  = refreshRenewalQuote;
window.renewalEditDep       = renewalEditDep;
window.renewalDeleteDep     = renewalDeleteDep;
window.renewalRestoreDep    = renewalRestoreDep;
window.renewalAddDependent  = renewalAddDependent;
window.renewalSaveMobile    = renewalSaveMobile;
window.submitRenewal        = submitRenewal;
window.renewalState         = renewalState;


// ═══════════════════════════════════════════════════════════════════════════════
// ─── ADMIN: Renewal Progress Dashboard ────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════
async function renderAdminRenewalProgress() {
  const c = document.getElementById('content');
  c.innerHTML = `<div class="loading"><div class="spinner"></div> Loading renewal progress…</div>`;

  let res;
  try { res = await renewal.admin.progress(); }
  catch (e) { c.innerHTML = `<div class="empty-state"><div class="icon">⚠️</div>${e.message}</div>`; return; }

  const rows = res.data || [];
  const t = res.totals || {};

  c.innerHTML = `
    <div class="stats-grid" style="margin-bottom:20px">
      <div class="stat-card blue"><div class="stat-icon">👥</div><div class="stat-label">Eligible Employees</div><div class="stat-value">${t.total_eligible || 0}</div></div>
      <div class="stat-card green"><div class="stat-icon">✅</div><div class="stat-label">Submitted</div><div class="stat-value">${t.submitted || 0}</div><div class="stat-sub">${t.progress_percent || 0}%</div></div>
      <div class="stat-card amber"><div class="stat-icon">👀</div><div class="stat-label">Visited / Not Submitted</div><div class="stat-value">${t.visited_not_submitted || 0}</div></div>
      <div class="stat-card blue"><div class="stat-icon">🔑</div><div class="stat-label">Logged In / Not Visited</div><div class="stat-value">${t.logged_in_not_visited || 0}</div></div>
      <div class="stat-card purple"><div class="stat-icon">🚪</div><div class="stat-label">Never Logged In</div><div class="stat-value">${t.never_logged_in || 0}</div></div>
    </div>

    <div style="background:white;border:1px solid var(--border);border-radius:14px;padding:16px;margin-bottom:16px">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;margin-bottom:12px">
        <h3 style="margin:0">📋 Per-Employee Progress</h3>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <input type="text" id="adm-renewal-search" placeholder="🔍 Search emp_id / name…"
            oninput="adminRenewalFilter(this.value)" style="padding:8px 10px;border:1px solid var(--border);border-radius:8px;font-size:13px;min-width:220px">
          <select id="adm-renewal-stage" onchange="adminRenewalFilter()" style="padding:8px 10px;border:1px solid var(--border);border-radius:8px;font-size:13px">
            <option value="">All stages</option>
            <option value="SUBMITTED">Submitted</option>
            <option value="VISITED_NOT_SUBMITTED">Visited / Not Submitted</option>
            <option value="LOGGED_IN_NOT_VISITED">Logged in / Not Visited</option>
            <option value="NEVER_LOGGED_IN">Never Logged In</option>
          </select>
          <button class="btn btn-secondary btn-sm" onclick="renderAdminRenewalProgress()">↺ Refresh</button>
        </div>
      </div>
      <div style="overflow-x:auto">
        <table class="data-table" id="adm-renewal-table">
          <thead><tr>
            <th>Emp ID</th><th>Name</th><th>Email</th><th>Stage</th>
            <th>Last Login</th><th>Last Visit</th><th>Submitted</th>
            <th>Reminders</th><th>Paused</th><th>Actions</th>
          </tr></thead>
          <tbody>
            ${rows.map(r => adminRenewalRow(r)).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;

  window._admRenewalRows = rows;
}

function adminRenewalRow(r) {
  const stageBadge = {
    SUBMITTED:             '<span class="badge badge-green">Submitted</span>',
    VISITED_NOT_SUBMITTED: '<span class="badge badge-amber">Visited</span>',
    LOGGED_IN_NOT_VISITED: '<span class="badge badge-blue">Logged In</span>',
    NEVER_LOGGED_IN:       '<span class="badge badge-red">Never Logged In</span>',
  }[r.stage] || r.stage;
  return `<tr data-stage="${r.stage}" data-search="${(r.emp_id+' '+(r.full_name||'')).toLowerCase()}">
    <td><code>${r.emp_id}</code></td>
    <td>${r.full_name || '—'}</td>
    <td style="font-size:11px">${r.email_id || '—'}</td>
    <td>${stageBadge}</td>
    <td style="font-size:12px">${r.last_logged_in_at ? rFmtDate(r.last_logged_in_at) : '—'}</td>
    <td style="font-size:12px">${r.visited_renewal_page_at ? rFmtDate(r.visited_renewal_page_at) : '—'}</td>
    <td style="font-size:12px">${r.submitted_at ? rFmtDate(r.submitted_at) : '—'}</td>
    <td>${r.reminder_count || 0}</td>
    <td>${r.reminder_paused ? '<span class="badge badge-red">Paused</span>' : '—'}</td>
    <td style="white-space:nowrap">
      ${r.stage !== 'SUBMITTED' ? `<button class="btn btn-secondary btn-sm" onclick="adminRenewalRemind('${r.emp_id}')">✉️ Remind</button>` : ''}
      <button class="btn btn-secondary btn-sm" onclick="adminRenewalTogglePause('${r.emp_id}', ${!r.reminder_paused})">${r.reminder_paused ? '▶' : '⏸'}</button>
    </td>
  </tr>`;
}

function adminRenewalFilter(searchVal) {
  if (searchVal !== undefined) document.getElementById('adm-renewal-search').value = searchVal;
  const s = (document.getElementById('adm-renewal-search')?.value || '').toLowerCase();
  const stage = document.getElementById('adm-renewal-stage')?.value || '';
  document.querySelectorAll('#adm-renewal-table tbody tr').forEach(tr => {
    const matchS = !s || tr.dataset.search.includes(s);
    const matchT = !stage || tr.dataset.stage === stage;
    tr.style.display = (matchS && matchT) ? '' : 'none';
  });
}

async function adminRenewalRemind(empId) {
  if (!confirm(`Send reminder email to ${empId}?`)) return;
  try {
    await renewal.admin.remind(empId);
    showToast('Reminder sent', 'success');
    renderAdminRenewalProgress();
  } catch (e) { showToast(e.message, 'error'); }
}

async function adminRenewalTogglePause(empId, paused) {
  try {
    await renewal.admin.pause(empId, paused);
    showToast(paused ? 'Reminders paused' : 'Reminders resumed', 'success');
    renderAdminRenewalProgress();
  } catch (e) { showToast(e.message, 'error'); }
}

window.renderAdminRenewalProgress = renderAdminRenewalProgress;
window.adminRenewalFilter         = adminRenewalFilter;
window.adminRenewalRemind         = adminRenewalRemind;
window.adminRenewalTogglePause    = adminRenewalTogglePause;
