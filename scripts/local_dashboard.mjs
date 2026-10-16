// ============================================================================
// local_dashboard.mjs — run the Site Monitor dashboard entirely off Docker.
//
// Supabase is down (unpaid), so the dashboard's cloud backend is gone. The full
// data and every RPC now live in the Docker archive, with PostgREST serving it
// on localhost:3001. This tiny server wires the existing index.html to that,
// with no change to the dashboard code and no Supabase:
//
//   GET /                -> serves index.html from the repo
//   GET /api/config      -> points the dashboard at THIS server
//   ANY /rest/v1/*        -> proxied to PostgREST (the /rest/v1 prefix stripped,
//                            exactly as Supabase's gateway mounts it)
//
// Same-origin for the browser, so CORS is a non-issue, and the dashboard cannot
// tell it is not talking to Supabase.
//
//   node scripts/local_dashboard.mjs      # then open http://localhost:8899
//
// Env: PORT (8899), PGRST (http://localhost:3001)
// ============================================================================
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEX = path.join(HERE, '..', 'index.html');
const PORT = Number(process.env.PORT || 8899);
const PGRST = (process.env.PGRST || 'http://localhost:3001').replace(/\/$/, '');
const ORIGIN = `http://localhost:${PORT}`;

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, ORIGIN);

  // 1) config — tell the dashboard to use this server as its backend
  if (u.pathname === '/api/config') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ supabaseUrl: ORIGIN, supabaseAnonKey: 'local-archive', psiKey: '' }));
    return;
  }

  // 2) the REST surface — strip /rest/v1 and hand to PostgREST, keeping the
  //    query string, method and body. PostgREST ignores the apikey/Authorization
  //    headers (no JWT secret set), so it runs everything as the anon role.
  if (u.pathname.startsWith('/rest/v1/')) {
    const target = PGRST + u.pathname.replace(/^\/rest\/v1/, '') + u.search;
    const headers = {};
    for (const h of ['content-type', 'prefer', 'range', 'range-unit', 'accept', 'accept-profile', 'content-profile'])
      if (req.headers[h]) headers[h] = req.headers[h];
    const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await readBody(req);
    try {
      const r = await fetch(target, { method: req.method, headers, body });
      const buf = Buffer.from(await r.arrayBuffer());
      const out = { 'Content-Type': r.headers.get('content-type') || 'application/json' };
      for (const h of ['content-range', 'content-location', 'content-profile'])
        if (r.headers.get(h)) out[h] = r.headers.get(h);
      res.writeHead(r.status, out);
      res.end(buf);
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'archive unreachable: ' + e.message }));
    }
    return;
  }

  // 3) the dashboard itself
  if (u.pathname === '/' || u.pathname === '/index.html') {
    fs.readFile(INDEX, (e, data) => {
      if (e) { res.writeHead(500); res.end('index.html not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  res.writeHead(404); res.end('not found');
});

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => resolve(undefined));
  });
}

server.listen(PORT, () => {
  console.log(`Site Monitor (Docker archive) — open  http://localhost:${PORT}`);
  console.log(`  backend: PostgREST at ${PGRST}  ·  data through the last sync, no Supabase`);
});
