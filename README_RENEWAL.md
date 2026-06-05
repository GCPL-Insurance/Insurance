# GCPL Insurance Portal — GMC Renewal 2026-27 Deployment Guide

This update adds the full **GMC Renewal 2026-27** module to the portal, plus two pre-existing bug fixes.

---

## 🐛 Bug fixes (no deployment steps — just merge & redeploy)

1. **Dashboard "Insured Members" count** — now reads from the latest `SUBMITTED`/`APPROVED` row in `employee_gmc_enrollment_insured` (not the raw `insurance_dependents` table). Fixes the "shows 1 instead of 4" issue.
2. **First-login `tokenStore is not defined` error** — `tokenStore` is now imported into `main.js`.

---

## 📦 What's new

| Layer | Item |
|---|---|
| **SQL** | 4 new tables, 4 new views (`sql/01_renewal_tables.sql`, `sql/02_renewal_views.sql`) |
| **Backend** | `/api/renewal/*` routes (`backend/src/routes/renewal.js`) |
| **Frontend** | `GMC Renewal 2026-27` employee page + `Renewal Progress 26-27` admin page |
| **Edge functions** | `send-renewal-reminders` (daily cron) + `send-renewal-confirmation` (on submit) |
| **Excel template** | `gmc_premium_rates_26_27_template.xlsx` (you fill annual_premium column) |

---

## 🚀 Deployment order

> Follow these steps **in order**. Each step is independent — you can stop and resume.

### Step 1 — Run SQL migrations

In the Supabase SQL editor, run **in this order**:

1. `sql/01_renewal_tables.sql` — creates the 4 new tables + seeds `renewal_monitor_2026_27` with every eligible employee.
2. `sql/02_renewal_views.sql` — creates the 4 new views.

**If step 2 errors out on a column name:** the views reference these existing tables — check that the column names match yours:

| View depends on… | Expected columns |
|---|---|
| `vw_employee_ctc_gmc_total` | `emp_id`, `total_ctc_gmc` |
| `employee_gmc_opening_balance` | `emp_id`, `opening_balance` |
| `employee_gmc_actual_deduction` | `emp_id`, `payroll_month` (YYYY-MM text), `amount` |
| `employee_gmc_enrollment` | `enrollment_id`, `emp_id`, `enrollment_status`, `submitted_at`, `policy_year`, `selected_sum_insured` |
| `employee_gmc_enrollment_summary` | `enrollment_id`, `total_insurer_premium` |
| `employee_gmc_enrollment_insured` | `enrollment_id`, `emp_id`, `insured_name`, `relationship`, `date_of_birth`, `gender`, `sum_insured`, `annual_premium`, `age_as_on_doj` |

**If `employee_gmc_enrollment.policy_year` doesn't exist yet**, add it:
```sql
ALTER TABLE employee_gmc_enrollment ADD COLUMN IF NOT EXISTS policy_year TEXT;
UPDATE employee_gmc_enrollment SET policy_year = '2025-26' WHERE policy_year IS NULL;
CREATE INDEX IF NOT EXISTS idx_enrollment_policy_year ON employee_gmc_enrollment(policy_year);
```

### Step 2 — Upload the premium rate matrix

1. Open `gmc_premium_rates_26_27_template.xlsx`.
2. Fill the **`annual_premium`** column for each of the 63 rows (7 Sum Insured options × 9 age bands). Leave others as-is.
3. In Supabase: **Table editor → `gmc_premium_rates_26_27` → Import data from CSV/Excel**.

The 9 age bands are: `0-17`, `18-35`, `36-45`, `46-55`, `56-65`, `66-70`, `71-75`, `76-80`, `81-120`.
The 7 Sum Insured options are: `200000`, `300000`, `400000`, `500000`, `600000`, `700000`, `1000000`.

### Step 3 — Upload `renewal_dependents_2026_27` seed data

Upload your cleaned-up dependent list (with corrected `emp_id` values) into the `renewal_dependents_2026_27` table.

Required columns: `emp_id`, `dependent_name`, `relation` (one of: `Spouse`, `Son`, `Daughter`, `Father`, `Mother`, `Father-in-Law`, `Mother-in-Law`), `date_of_birth`, `gender`.
All other columns (`action`, `is_locked`, `edited`, etc.) take their defaults.

### Step 4 — Deploy edge functions

```bash
cd Insurance/supabase
supabase functions deploy send-renewal-reminders
supabase functions deploy send-renewal-confirmation
```

Then set the function env vars (Supabase dashboard → Edge Functions → Manage Secrets):

| Variable | Example value |
|---|---|
| `SMTP_HOST` | `smtp.office365.com` |
| `SMTP_PORT` | `587` |
| `SMTP_USER` | `noreply@globalcalcium.com` (your Outlook sender) |
| `SMTP_PASS` | (app password) |
| `FROM_EMAIL` | `noreply@globalcalcium.com` |
| `FROM_NAME` | `GCPL Insurance Portal` |
| `PORTAL_URL` | `https://gcpl.insurance-portal.in` |
| `FUNCTION_SECRET` | (long random string — same value as backend env var) |

### Step 5 — Set backend env vars on Render

Add to your Render service (in addition to the existing ones):

| Variable | Notes |
|---|---|
| `FUNCTION_SECRET` | Same value as the edge function `FUNCTION_SECRET` |

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` should already be set.

### Step 6 — Schedule the daily reminder cron

Run this in the Supabase SQL editor (pg_cron is enabled on Pro tier):

```sql
-- 11:30 UTC = 17:00 IST daily
SELECT cron.schedule(
  'renewal-reminders-daily',
  '30 11 * * *',
  $$
    SELECT net.http_post(
      url := 'https://<YOUR-PROJECT>.supabase.co/functions/v1/send-renewal-reminders',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer <SERVICE-ROLE-KEY>'
      ),
      body := jsonb_build_object('secret', '<FUNCTION_SECRET>', 'source', 'CRON')
    );
  $$
);
```

The function itself checks the renewal window (1 Jul → 15 Jul 2026) and silently skips runs outside that window, so it's safe to leave the cron job permanently scheduled.

To remove later: `SELECT cron.unschedule('renewal-reminders-daily');`

### Step 7 — Deploy backend + frontend to Render

Push to `main` (or your deploy branch). Render will rebuild both services automatically.

---

## ✅ Post-deployment verification checklist

After steps 1–7, verify in this order:

1. **Supabase**:
   - [ ] `SELECT count(*) FROM renewal_monitor_2026_27;` returns your eligible-employee count.
   - [ ] `SELECT count(*) FROM gmc_premium_rates_26_27;` returns 63.
   - [ ] `SELECT count(*) FROM renewal_dependents_2026_27;` returns your seeded count.
   - [ ] `SELECT * FROM vw_renewal_progress LIMIT 5;` works.
2. **Admin login → "Renewal Progress 26-27"** sidebar item:
   - [ ] Shows the stats (Eligible / Submitted / Visited / Never Logged In).
   - [ ] Table lists employees with their stage.
   - [ ] "Send Reminder" button works for one test employee.
3. **Employee login → "GMC Renewal 2026-27"** sidebar item (after 1 Jul):
   - [ ] Step 1 T&C → check box → continue.
   - [ ] Step 2 shows employee details + 25-26 figures.
   - [ ] Step 3 shows SI selector (current SI and above only), dependents (editable/deletable), and live financial summary.
   - [ ] Submitting creates a `2026-27` row in `employee_gmc_enrollment` + insured members + locks `renewal_dependents_2026_27`.
   - [ ] Confirmation email arrives within 30 s.

> Before 1 Jul 2026, employees will see a "renewal has not opened yet" screen on the renewal page. Admin can still see the progress dashboard at any time.

---

## 📋 Schema reference for the new tables

### `gmc_premium_rates_26_27`
| column | type | notes |
|---|---|---|
| sum_insured | NUMERIC | One of 200000, 300000, 400000, 500000, 600000, 700000, 1000000 |
| age_min | INT | Inclusive |
| age_max | INT | Inclusive |
| annual_premium | NUMERIC | The amount the insurer charges per member per year |

### `renewal_dependents_2026_27`
| column | type | notes |
|---|---|---|
| emp_id | TEXT | |
| dependent_name | TEXT | Editable by employee |
| relation | TEXT | **LOCKED** — Spouse / Son / Daughter / Father / Mother / Father-in-Law / Mother-in-Law |
| date_of_birth | DATE | Editable |
| gender | TEXT | Editable |
| action | TEXT | `KEEP` (default) or `DELETE` |
| delete_reason | TEXT | `EXPIRED` or `NOT_CONTINUING` (required when action=`DELETE`) |
| edited | BOOL | Set to true on any field edit |
| is_locked | BOOL | Set to true on submission |
| enrollment_id | BIGINT | Set to the renewal enrollment id on submission |

### `renewal_monitor_2026_27`
One row per eligible employee. Tracks login / page visit / submission / reminder counts.

### `renewal_reminder_log`
Append-only audit log. Every reminder attempt (sent / failed / skipped) is logged with the trigger source (`CRON` or `MANUAL`) and the admin who triggered it.

---

## 🧮 Financial formulas (reference)

For each renewal submission:

```
Net Balance       = Closing 25-26 + CTC GMC 26-27 − Premium 26-27
Refund Sep-2026   = max(0, min(Closing 25-26, Net))
Refund Sep-2027*  = max(0, Net − Refund Sep-2026)
Salary Deduction  = max(0, −Net)
EMI / month       = Salary Deduction / 6     [Sep 2026 → Feb 2027]

Closing 25-26     = CTC 25-26 + Opening 25-26 + Salary Deductions 25-26 − Premium 25-26
```

*Sep-2027 refund is an **estimate** and depends on the 2027-28 increment + enrollment.*

All employee-facing premium displays carry a **±10%** disclaimer.

---

## 🔒 Business rules enforced

- ✅ Sum Insured can be increased or kept the same; **cannot be decreased**.
- ✅ Operator-level employees (current SI = ₹2L) can choose ₹2L+; others (current SI = ₹3L+) only see ₹3L and above. *(Handled by the "≥ current" filter.)*
- ✅ No new dependents can be added.
- ✅ Existing dependents: relation locked; name/DOB/gender editable; can be deleted with reason.
- ✅ Deleted-and-submitted dependents cannot be re-added in future renewals (rows are locked after submission).
- ✅ Renewal can only be submitted between 1 Jul and 15 Jul 2026 by employees (admins/HR can submit on behalf any time).
- ✅ One renewal per employee per policy year (duplicate submissions blocked).

---

## 📨 Reminder cadence

- Daily at **17:00 IST** from 1 Jul to 15 Jul 2026.
- 22-hour cooldown per employee on cron path (so multiple cron firings same day don't double-send).
- Stops the moment an employee submits (their row exits the cron's selection set).
- Admin can pause reminders per-employee (e.g. for someone on leave).
- Admin can also send a manual reminder anytime (bypasses cooldown and window check).

---

## 📂 File map (what's where)

```
sql/
├── 01_renewal_tables.sql              ← run 1st
└── 02_renewal_views.sql               ← run 2nd

backend/src/
├── index.js                            ← (modified) mounts /api/renewal
└── routes/
    └── renewal.js                      ← (new) all /api/renewal/* endpoints

frontend/src/
├── lib/api.js                          ← (modified) adds `renewal` export
└── main.js                             ← (modified) renewal page + admin dashboard + bug fixes

frontend/
└── index.html                          ← (modified) adds 2 sidebar items

supabase/functions/
├── send-renewal-reminders/index.ts     ← (new) daily cron
└── send-renewal-confirmation/index.ts  ← (new) post-submit email

gmc_premium_rates_26_27_template.xlsx   ← (new) premium rate Excel to fill
```

---

## ❓ If you hit issues

- **SQL view errors** — most likely a column name mismatch in one of the source tables. Edit the relevant CTE in `02_renewal_views.sql` and re-run.
- **Backend 500 on `/api/renewal/eligibility`** — check that `vw_employee_gmc_26_27_calc` was created successfully and that the employee exists in `employees` with `gmc_inclusion_date` set.
- **Frontend "Premium rates not configured"** — `gmc_premium_rates_26_27` is empty or missing the SI value the employee selected. Re-upload the Excel.
- **No reminder emails** — check the function logs in Supabase dashboard. Common causes: missing SMTP env vars, wrong `FUNCTION_SECRET`, or `email_id` blank in `renewal_monitor_2026_27`.

For everything else, raise an issue or check the function logs.
