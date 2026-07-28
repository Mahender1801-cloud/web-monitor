// ============================================================================
// Public runtime config.  GET /api/config
//
// Serves the Supabase URL + anon key from Vercel env vars so they are no longer
// hard-coded in index.html (and no longer shown in a visible "Connect" dialog).
//
// HONEST SCOPE: the anon key is still delivered to the browser — it has to be,
// because the browser is what queries Supabase. Anyone can read it from the
// network tab. That is fine ONLY because Row Level Security limits what it can
// do; see SECURITY_rls_lockdown.sql. Treat this endpoint as tidiness, not as a
// secret store. Never put the service_role key here.
//
// Vercel env vars: SUPABASE_URL, SUPABASE_ANON_KEY
// ============================================================================

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.status(200).json({
    supabaseUrl: process.env.SUPABASE_URL || '',
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '',
    psiProxy: true            // the client should call /api/psi, never Google directly
  });
}
