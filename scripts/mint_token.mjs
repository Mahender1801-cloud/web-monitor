// ============================================================================
// mint_token.mjs — issue the anon (and service) keys for the self-hosted API.
//
// Only needed if you are breaking from Supabase's JWT secret. Reuse that secret
// in docker/.env and the anon key already deployed in webvitals.js keeps
// working, which means the theme is edited once (the URL) instead of twice.
//
// A Supabase anon key is nothing more than an HS256 JWT whose payload says
// {"role":"anon"}. PostgREST reads the same thing. That is why the client code
// does not change: same header, same shape, different host.
//
//   node scripts/mint_token.mjs                 # reads JWT_SECRET from docker/.env
//   node scripts/mint_token.mjs --years 10
//
// The service key bypasses RLS. It belongs in GitHub Actions secrets and
// nowhere else — never in webvitals.js, never in the dashboard, never in a
// commit. Anything holding it can read and delete every row.
// ============================================================================
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV  = path.join(ROOT, 'docker', '.env');

let secret = process.env.JWT_SECRET;
if (!secret && fs.existsSync(ENV)) {
  const m = fs.readFileSync(ENV, 'utf8').match(/^JWT_SECRET=(.*)$/m);
  if (m) secret = m[1].trim();
}
if (!secret) {
  console.error('No JWT_SECRET. Put one in docker/.env, or pass it in the environment.');
  console.error('Generate one with:  openssl rand -base64 48');
  process.exit(1);
}
if (secret.length < 32) {
  // PostgREST will accept a short secret; an attacker will accept it faster.
  console.error(`JWT_SECRET is ${secret.length} characters. Use at least 32 — a short`);
  console.error('HS256 secret is brute-forceable offline from a single captured token.');
  process.exit(1);
}

const yearsArg = process.argv.indexOf('--years');
const years = yearsArg > -1 ? Number(process.argv[yearsArg + 1]) : 5;

const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o))
  .toString('base64url');

function mint(role) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({ role, iss: 'web-monitor', iat: now,
                     exp: now + Math.round(years * 365.25 * 86400) });
  const sig  = crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

const anon = mint('anon');
const svc  = mint('service_role');

console.log(`\nValid for ${years} years.\n`);
console.log('ANON KEY — safe in the browser, limited by RLS.');
console.log('Goes in webvitals.js and the Vercel SUPABASE_ANON_KEY env var:\n');
console.log(anon + '\n');
console.log('SERVICE KEY — bypasses RLS. GitHub Actions secret only:\n');
console.log(svc + '\n');
console.log('Check one before you deploy it:  https://jwt.io  (paste, confirm role and exp)');
