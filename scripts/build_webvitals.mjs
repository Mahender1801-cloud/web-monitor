// ============================================================================
// build_webvitals.mjs — produce the copy that goes into the Shopify theme.
//
// webvitals.js is written to be read: 62 comment lines explaining why each
// listener exists, which is what makes it maintainable by whoever comes next.
// The theme does not need any of that, and the file is fetched by every visitor
// on every page.
//
// Measured on the live store: the deployed asset is 3,604 bytes gzipped, the
// repo file 6,748. Uploading the repo file as-is would nearly double what every
// shopper downloads, to deliver comments none of them read.
//
// So this strips comments and nothing else. No renaming, no reordering, no
// collapsing — the code that ships is the code in the repo, line for line, so a
// stack trace from a shopper's browser still points at something recognisable.
//
// Only whole-line comments are removed. A tokenizer that understood strings,
// template literals and regex literals could take the inline ones too, and
// could also get one of them wrong and ship a broken beacon. The saving is not
// worth that risk, and the output is verified before it is written.
//
//   node scripts/build_webvitals.mjs
//   -> webvitals.theme.js, which is what you upload
// ============================================================================
import fs from 'fs';
import { execFileSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC  = path.join(ROOT, 'webvitals.js');
const OUT  = path.join(ROOT, 'webvitals.theme.js');

const src = fs.readFileSync(SRC, 'utf8');
const lines = src.split(/\r?\n/);

// A line inside a multi-line template literal could begin with // and mean it
// literally. Find those regions first and never touch them.
const inTemplate = new Array(lines.length).fill(false);
{
  let open = false;
  for (let i = 0; i < lines.length; i++) {
    inTemplate[i] = open;
    // Count unescaped backticks that are not themselves inside a line comment.
    const code = open ? lines[i] : lines[i].replace(/\/\/.*$/, '');
    const ticks = (code.match(/(?<!\\)`/g) || []).length;
    if (ticks % 2 === 1) open = !open;
  }
}

const out = [];
let block = false, removed = 0;
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  const t = line.trim();
  if (inTemplate[i]) { out.push(line); continue; }
  if (block) { removed++; if (t.endsWith('*/')) block = false; continue; }
  if (t.startsWith('/*')) { removed++; if (!t.endsWith('*/')) block = true; continue; }
  if (t.startsWith('//')) { removed++; continue; }
  if (t === '' && out.length && out[out.length - 1].trim() === '') { removed++; continue; }
  out.push(line);
}

const built = out.join('\n').replace(/\n{3,}/g, '\n\n');
fs.writeFileSync(OUT, built);

// Verify before claiming anything. A build step that can silently ship broken
// JavaScript to every visitor is worse than no build step.
try { execFileSync('node', ['--check', OUT], { stdio: 'pipe' }); }
catch (e) {
  fs.unlinkSync(OUT);
  console.error('the stripped file does not parse — nothing written.');
  console.error((e.stderr || e.message || '').toString().slice(0, 400));
  process.exit(1);
}

// Every non-comment line of the source must survive verbatim.
const codeOf = (s) => s.split(/\r?\n/).map(l => l.trim())
  .filter(l => l && !l.startsWith('//') && !l.startsWith('/*') && !l.startsWith('*'));
const a = codeOf(src), b = codeOf(built);
const drifted = a.length !== b.length || a.some((l, i) => l !== b[i]);
if (drifted) {
  fs.unlinkSync(OUT);
  console.error(`code changed during stripping (${a.length} lines in, ${b.length} out) — nothing written.`);
  process.exit(1);
}

const gz = (f) => execFileSync('sh', ['-c', `gzip -c "${f}" | wc -c`], { encoding: 'utf8' }).trim();
console.log(`${path.basename(SRC)}  ${fs.statSync(SRC).size} bytes, ${gz(SRC)} gzipped`);
console.log(`${path.basename(OUT)}  ${fs.statSync(OUT).size} bytes, ${gz(OUT)} gzipped`);
console.log(`${removed} comment/blank lines removed, ${b.length} code lines unchanged.`);
console.log(`\nUpload ${path.basename(OUT)} to the theme as assets/webvitals.js`);
