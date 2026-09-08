// ============================================================================
// archive_and_prune.mjs — the safe recurring job that keeps Supabase small.
//
// Runs on this machine (Windows Task Scheduler), NOT in the cloud, for one
// unavoidable reason: the Docker archive lives here and has no public address,
// so a GitHub Action could never reach it. If the prune ran in the cloud it
// would delete rows from Supabase that this machine had not yet copied.
//
// So the order is fixed and each step gates the next:
//   1. sync every new row from Supabase into the Docker archive
//   2. prove the archive now holds everything older than the keep window
//   3. only then, delete that old raw from Supabase
//
// Aggregates never move — rum_daily (and its by_group / by_visitor summaries)
// stay in Supabase forever, so every report keeps working. Only the raw
// per-row tables are trimmed, and only after they are safe in Docker.
//
//   node scripts/archive_and_prune.mjs            # sync, verify, prune
//   node scripts/archive_and_prune.mjs --dry-run  # sync + verify, delete nothing
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY (delete needs the service key — the
//      public anon key deliberately cannot delete), plus the Docker archive up.
//      RUM_KEEP_DAYS (14), HEALTH_KEEP_DAYS (7)
// ============================================================================
import fs from 'fs';
import { execFileSync, spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const wv = fs.readFileSync(path.join(HERE, '..', 'webvitals.js'), 'utf8');
const URL_ = process.env.SUPABASE_URL || wv.match(/SUPABASE_URL\s*=\s*'([^']+)'/)[1];
const SERVICE = process.env.SUPABASE_SERVICE_KEY;
const RUM_KEEP = Number(process.env.RUM_KEEP_DAYS || 14);
const HEALTH_KEEP = Number(process.env.HEALTH_KEEP_DAYS || 7);
const DRY = process.argv.includes('--dry-run');

const log = (...a) => console.log(new Date().toISOString().slice(0, 19), ...a);

// Deleting is gated on the service key on purpose. The prune RPCs are not
// SECURITY DEFINER, so a caller needs real delete rights — which the anon key
// does not have. That means the public key in the browser cannot trim the
// database even if someone found and called the function.
if (!DRY && !SERVICE) {
  console.error('SUPABASE_SERVICE_KEY is required to prune (delete). Set it in the');
  console.error('scheduled task environment. Or run with --dry-run to sync + verify only.');
  process.exit(1);
}

const node = process.execPath;
function run(script, args = []) {
  const r = spawnSync(node, [path.join(HERE, script), ...args], { stdio: 'inherit' });
  return r.status === 0;
}

// --- step 1: pull everything new into the archive -------------------------
log('1/3 syncing Supabase -> Docker archive…');
if (!run('db_sync.mjs')) { console.error('sync failed — not pruning.'); process.exit(1); }

// --- step 2: prove the archive covers the range about to be deleted --------
log('2/3 verifying the archive covers the prune range…');
const gate = spawnSync(node, [path.join(HERE, 'prune_gate.mjs')], { stdio: 'inherit' });
if (gate.status !== 0) {
  console.error('archive does NOT yet cover everything the prune would remove — stopping.');
  console.error('Nothing was deleted. It will catch up on the next run.');
  process.exit(1);
}

if (DRY) { log('dry run — archive is safe, skipping the delete.'); process.exit(0); }

// --- step 3: trim Supabase --------------------------------------------------
const H = { apikey: SERVICE, Authorization: 'Bearer ' + SERVICE, 'Content-Type': 'application/json' };
async function rpc(fn, body) {
  const r = await fetch(`${URL_}/rest/v1/rpc/${fn}`, { method: 'POST', headers: H, body: JSON.stringify(body || {}) });
  if (!r.ok) throw new Error(`${fn}: HTTP ${r.status} ${(await r.text()).slice(0, 120)}`);
  return r.json();
}

log('3/3 pruning Supabase…');
try {
  // rum_prune only removes days rum_daily already summarises, so a report can
  // never lose a day the rollup has not captured.
  const pruned = await rpc('rum_prune', { p_keep_days: RUM_KEEP });
  const rumRows = Array.isArray(pruned) ? pruned.reduce((a, r) => a + (r.deleted > 0 ? +r.deleted : 0), 0) : 0;
  const skipped = Array.isArray(pruned) ? pruned.filter(r => r.deleted === -1).map(r => r.day) : [];
  log(`   rum_events: removed ${rumRows.toLocaleString()} old rows` +
      (skipped.length ? `; skipped ${skipped.length} day(s) not yet summarised: ${skipped.slice(0, 3).join(', ')}` : ''));

  const hRows = await rpc('health_prune', { p_keep_days: HEALTH_KEEP });
  log(`   health_events: removed ${(+hRows || 0).toLocaleString()} rows older than ${HEALTH_KEEP} days`);

  // Close alerts whose condition cleared, and age out ones nothing can close.
  try { await rpc('alerts_autoresolve', {}); await rpc('alerts_expire', { p_days: 3 }); } catch {}
} catch (e) {
  console.error('prune failed:', (e.message || e).slice(0, 200));
  process.exit(1);
}

log('done. Aggregates untouched; raw trimmed and safe in the archive.');
log('Note: deleted space is reused by new rows automatically. A one-time');
log('VACUUM FULL is only needed once, before the first downgrade to Free.');
