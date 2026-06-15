// lib/api.js — All requests go through the backend. No Supabase keys here.

const API_BASE = import.meta.env.VITE_API_URL || '/api';

// ─── Token management ─────────────────────────────────────────────────────────
export const tokenStore = {
  get:         () => localStorage.getItem('ip_token'),
  set:         (t) => localStorage.setItem('ip_token', t),
  getRefresh:  () => localStorage.getItem('ip_refresh'),
  setRefresh:  (t) => localStorage.setItem('ip_refresh', t),
  clear:       () => {
    localStorage.removeItem('ip_token');
    localStorage.removeItem('ip_refresh');
    localStorage.removeItem('ip_user');
  },
  getUser:     () => { try { return JSON.parse(localStorage.getItem('ip_user')); } catch { return null; } },
  setUser:     (u) => localStorage.setItem('ip_user', JSON.stringify(u)),
};

let isRefreshing = false;
let refreshPromise = null;

async function refreshToken() {
  if (isRefreshing) return refreshPromise;
  isRefreshing = true;
  refreshPromise = fetch(`${API_BASE}/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: tokenStore.getRefresh() }),
  })
    .then(r => r.json())
    .then(data => {
      if (data.access_token) {
        tokenStore.set(data.access_token);
        tokenStore.setRefresh(data.refresh_token);
        return data.access_token;
      }
      tokenStore.clear();
      window.location.reload();
      return null;
    })
    .finally(() => { isRefreshing = false; refreshPromise = null; });
  return refreshPromise;
}

// ── Retry helper: retries once on network-level failures (TypeError: Failed to fetch)
// This handles Render free-tier cold-start mid-request crashes where the DB write
// already succeeded but the HTTP response was never sent back to the browser.
async function fetchWithRetry(url, opts, retries = 1) {
  try {
    return await fetch(url, opts);
  } catch (err) {
    // Only retry on network errors (TypeError), not on HTTP error responses
    if (retries > 0 && err instanceof TypeError) {
      // Wait 2s then retry — gives Render instance time to recover
      await new Promise(r => setTimeout(r, 2000));
      return fetchWithRetry(url, opts, retries - 1);
    }
    // Re-throw with a friendlier message so the UI shows something useful
    const friendly = new Error(
      'Network error — the server may be restarting. ' +
      'Please wait a moment and refresh the page. ' +
      'If the action was a save/approve, check the data — it may have already been saved.'
    );
    friendly.isNetworkError = true;
    throw friendly;
  }
}

export async function apiFetch(path, options = {}) {
  const token = tokenStore.get();
  const headers = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...options.headers,
  };

  // Determine if this is a mutation (write) — these are most affected by cold-start
  const isMutation = options.method && ['POST','PATCH','PUT','DELETE'].includes(options.method.toUpperCase());

  // Never serve API data from the browser HTTP cache (e.g. stale renewal/admin GETs).
  let res = await fetchWithRetry(`${API_BASE}${path}`, { ...options, headers, cache: 'no-store' }, isMutation ? 1 : 0);

  // Auto-refresh on 401 — but NOT for auth routes (login/logout/forgot-password)
  // Auth routes returning 401 mean wrong credentials, not expired tokens.
  const isAuthRoute = path.startsWith('/auth/login') || path.startsWith('/auth/logout') ||
    path.startsWith('/auth/forgot') || path.startsWith('/auth/change-password');

  if (res.status === 401 && !isAuthRoute && tokenStore.getRefresh()) {
    const newToken = await refreshToken();
    if (newToken) {
      res = await fetchWithRetry(`${API_BASE}${path}`, {
        ...options,
        headers: { ...headers, Authorization: `Bearer ${newToken}` },
      }, 0);
    }
  }

  if (res.status === 401 && !isAuthRoute) {
    tokenStore.clear();
    window.location.reload();
    return;
  }

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    // 429 = rate limited. With the old code, authLimiter on /api/auth/*
    // would silently cap enrollment saves/submits, leaving the UI frozen.
    // Now enrollment has its own generous limit (200/15min) but we still
    // surface the error clearly if it ever fires.
    if (res.status === 429) {
      const friendly = new Error(
        data.error || 'Too many requests — please wait a moment and try again.'
      );
      friendly.isRateLimit = true;
      throw friendly;
    }

    // 503 = server-side timeout (our 25s guard in auth.js).
    // Tell the user their data may be saved and to refresh before retrying.
    if (res.status === 503) {
      const friendly = new Error(
        data.error ||
        'The server took too long to respond. Please refresh the page to check if your submission was saved before trying again.'
      );
      friendly.isTimeout = true;
      throw friendly;
    }

    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data;
}

// ─── Auth ─────────────────────────────────────────────────────────────────────
export const auth = {
  login: async (email, password, captchaToken) => {
    const data = await apiFetch('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password, captchaToken }),
    });
    tokenStore.set(data.access_token);
    tokenStore.setRefresh(data.refresh_token);
    tokenStore.setUser(data.user);
    return data.user;
  },
  logout: async () => {
    await apiFetch('/auth/logout', { method: 'POST' }).catch(() => {});
    tokenStore.clear();
  },
  me: () => tokenStore.getUser(),
  isLoggedIn: () => !!tokenStore.get(),
  validate: async () => {
    const data = await apiFetch('/auth/me');
    if (data?.user) {
      tokenStore.setUser(data.user);
      return data.user;
    }
    return null;
  },
  setPassword: async (access_token, refresh_token, new_password) => {
    const data = await apiFetch('/auth/set-password', {
      method: 'POST',
      body: JSON.stringify({ access_token, refresh_token, new_password }),
    });
    tokenStore.set(data.access_token);
    tokenStore.setRefresh(data.refresh_token);
    tokenStore.setUser(data.user);
    return data.user;
  },
  // Send forgot-password email
  forgotPassword: (email) => apiFetch('/auth/forgot-password', {
    method: 'POST',
    body: JSON.stringify({ email }),
  }),
  // Change password for logged-in user (clears must_change_password flag)
  changePassword: (current_password, new_password) => apiFetch('/auth/change-password', {
    method: 'POST',
    body: JSON.stringify({ current_password, new_password }),
  }),
};

// ─── Tables ───────────────────────────────────────────────────────────────────
export const tables = {
  list: (table, params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return apiFetch(`/data/${table}${qs ? '?' + qs : ''}`);
  },
  insert: (table, body) =>
    apiFetch(`/data/${table}`, { method: 'POST', body: JSON.stringify(body) }),

  update: (table, id, body, keyCol = 'id') => {
    const qs = keyCol !== 'id' ? `?keyCol=${encodeURIComponent(keyCol)}` : '';
    return apiFetch(`/data/${table}/${id}${qs}`, { method: 'PATCH', body: JSON.stringify(body) });
  },

  remove: (table, id, keyCol = 'id') => {
    const qs = keyCol !== 'id' ? `?keyCol=${encodeURIComponent(keyCol)}` : '';
    return apiFetch(`/data/${table}/${id}${qs}`, { method: 'DELETE' });
  },

  bulkInsert: (table, rows) =>
    apiFetch(`/data/${table}/bulk`, { method: 'POST', body: JSON.stringify({ rows }) }),
};

// ─── Views ────────────────────────────────────────────────────────────────────
export const views = {
  fetch: (viewName, params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return apiFetch(`/views/${viewName}${qs ? '?' + qs : ''}`);
  },
  employeeFull: (empId) => apiFetch(`/views/employee-full/${encodeURIComponent(empId)}`),
};

// ─── Admin ────────────────────────────────────────────────────────────────────
export const admin = {
  users: {
    list:          ()          => apiFetch('/admin/users'),
    create:        (body)      => apiFetch('/admin/users', { method: 'POST', body: JSON.stringify(body) }),
    update:        (id, body)  => apiFetch(`/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    remove:        (id)        => apiFetch(`/admin/users/${id}`, { method: 'DELETE' }),
    resetPassword: (id, pwd)   => apiFetch(`/admin/users/${id}/reset-password`, { method: 'POST', body: JSON.stringify({ password: pwd }) }),
  },
};

// ─── Export helpers ───────────────────────────────────────────────────────────
export const exportData = {
  table: (table, params) => apiFetch('/export/table', { method: 'POST', body: JSON.stringify({ table, ...params }) }),
  view:  (view, params)  => apiFetch('/export/view',  { method: 'POST', body: JSON.stringify({ view, ...params }) }),
};

// ─── Enrollment (employee self-service) ──────────────────────────────────────
export const enrollment = {
  // Verify emp_id exists before signup (no auth needed)
  verifyEmp: (emp_id) =>
    apiFetch('/auth/verify-emp', { method: 'POST', body: JSON.stringify({ emp_id }) }),

  // GMC Portal: verify emp_id — works even if employee not in DB yet
  gmcVerifyEmp: (emp_id) =>
    apiFetch('/auth/gmc-verify-emp', { method: 'POST', body: JSON.stringify({ emp_id }) }),

  // Create account (no auth needed) — for employees already in DB
  signup: (body, captchaToken) =>
    apiFetch('/auth/signup', { method: 'POST', body: JSON.stringify({ ...body, captchaToken }) }),

  // GMC Portal: create account for NEW employees NOT yet in DB
  gmcSignup: (body, captchaToken) =>
    apiFetch('/auth/gmc-signup', { method: 'POST', body: JSON.stringify({ ...body, captchaToken }) }),

  // Update CTC GMC per month (employee self-service)
  updateCtc: (ctc_gmc_per_month) =>
    apiFetch('/auth/update-ctc', { method: 'PATCH', body: JSON.stringify({ ctc_gmc_per_month }) }),

  // Simple signup — no emp_id verification, direct onboarding insert
  simpleSignup: (body, captchaToken) =>
    apiFetch('/auth/simple-signup', { method: 'POST', body: JSON.stringify({ ...body, captchaToken }) }),

  // Get employee data + rate cards + existing enrollment (auth required)
  getData: () => apiFetch('/auth/enrollment-data'),

  // Save draft or submit enrollment
  save: (body) =>
    apiFetch('/auth/enrollment', { method: 'POST', body: JSON.stringify({ ...body, action: 'save' }) }),
  submit: (body) =>
    apiFetch('/auth/enrollment', { method: 'POST', body: JSON.stringify({ ...body, action: 'submit' }) }),
};

// ─── Admin Enrollment Review ──────────────────────────────────────────────────
export const adminEnrollment = {
  list: (status) => {
    const qs = status && status !== 'ALL' ? `?status=${status}` : '';
    return apiFetch(`/admin/enrollments${qs}`);
  },
  detail: (id)   => apiFetch(`/admin/enrollments/${id}`),
  review: (id, action, admin_remarks) =>
    apiFetch(`/admin/enrollments/${id}`, { method: 'PATCH', body: JSON.stringify({ action, admin_remarks }) }),
};

// ─── GMC Renewal 2026-27 ──────────────────────────────────────────────────────
export const renewal = {
  eligibility: (emp_id) => {
    const qs = emp_id ? `?emp_id=${encodeURIComponent(emp_id)}` : '';
    return apiFetch(`/renewal/eligibility${qs}`);
  },
  dependents: (empId) => apiFetch(`/renewal/dependents/${encodeURIComponent(empId)}`),
  addDependent:     (empId, body)      => apiFetch(`/renewal/dependents/${encodeURIComponent(empId)}`,   { method: 'POST',  body: JSON.stringify(body) }),
  editDependent:    (id, body)         => apiFetch(`/renewal/dependents/${id}`,        { method: 'PATCH', body: JSON.stringify(body) }),
  deleteDependent:  (id, reason)       => apiFetch(`/renewal/dependents/${id}/delete`, { method: 'POST',  body: JSON.stringify({ reason }) }),
  restoreDependent: (id)               => apiFetch(`/renewal/dependents/${id}/restore`,{ method: 'POST' }),
  quote:  (body) => apiFetch('/renewal/quote',  { method: 'POST', body: JSON.stringify(body) }),
  submit: (body) => apiFetch('/renewal/submit', { method: 'POST', body: JSON.stringify(body) }),
  trackLogin: () => apiFetch('/renewal/_track-login', { method: 'POST' }).catch(() => null),
  updateContact: (body) => apiFetch('/renewal/_update-contact', { method: 'POST', body: JSON.stringify(body) }),
  admin: {
    progress: ()            => apiFetch('/renewal/admin/progress'),
    remind:   (empId)       => apiFetch(`/renewal/admin/remind/${encodeURIComponent(empId)}`, { method: 'POST' }),
    pause:    (empId, paused) => apiFetch(`/renewal/admin/pause/${encodeURIComponent(empId)}`, { method: 'POST', body: JSON.stringify({ paused }) }),
  },
};