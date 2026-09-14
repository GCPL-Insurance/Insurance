// Direct Postgres connection — bypasses PostgREST (and its schema cache) so that
// critical financial views (F&F register) always return CURRENT data, exactly like
// the Supabase SQL editor. Set DATABASE_URL in Render (Supabase → Settings → Database
// → Connection string → URI, use the Session/Transaction pooler URI).
import pg from 'pg';

const { Pool } = pg;
let pool = null;

if (process.env.DATABASE_URL) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },   // Supabase requires SSL
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });
  pool.on('error', (err) => console.error('[pg pool] idle client error:', err.message));
  console.log('✅ Direct Postgres pool initialised (F&F reads bypass PostgREST cache)');
} else {
  console.warn('⚠️  DATABASE_URL not set — F&F reads will use PostgREST (may serve stale view cache). Set DATABASE_URL to fix.');
}

export const pgPool = pool;
export const hasDirectDb = () => pool !== null;

// Parameterised query helper. Throws if no pool configured.
export async function pgQuery(text, params = []) {
  if (!pool) throw new Error('DATABASE_URL not configured');
  const client = await pool.connect();
  try { return await client.query(text, params); }
  finally { client.release(); }
}
