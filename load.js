// load.js
// Run from the terminal: node load.js "C:\path\to\UCC_2015-Current.xlsx"
// Loads the UCC export into the ucc_facts table in the sales-funnel Turso DB,
// using the same hash-based incremental upsert approach as ExcaVision's ucc_filings loader.
//
// Requires (package.json): @libsql/client, xlsx
// Requires env vars: TURSO_DATABASE_URL, TURSO_AUTH_TOKEN
// (set these in a local .env and load with `node -r dotenv/config load.js ...`,
//  or export them in your shell before running, matching however Sales Funnel's
//  load.js already gets its credentials.)

import { createClient } from '@libsql/client';
import XLSX from 'xlsx';
import path from 'path';
import zlib from 'zlib';

const TURSO_URL = process.env.TURSO_DATABASE_URL;
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN;

if (!TURSO_URL || !TURSO_TOKEN) {
  console.error('Missing TURSO_DATABASE_URL / TURSO_AUTH_TOKEN env vars.');
  process.exit(1);
}

const filePath = process.argv[2];
if (!filePath) {
  console.error('Usage: node load.js <path-to-UCC_2015-Current.xlsx>');
  process.exit(1);
}

let client = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });

// ── Hashing (identical to ExcaVision's hashStr/hashRow, for consistency) ──
function hashStr(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i);
    hash = hash & hash;
  }
  return (hash >>> 0).toString(36);
}
function hashRow(fields) {
  return hashStr(fields.map((f) => String(f == null ? '' : f)).join('|'));
}

function money(v) {
  const sv = String(v || 0).replace(/[$,]/g, '');
  return parseFloat(sv) || 0;
}

// Normalizes whatever date shape SheetJS hands back (observed as MM/DD/YYYY
// despite the dateNF option) into a strict ISO YYYY-MM-DD string. Falls back
// to passing the value through unchanged if it doesn't match a known shape,
// so unexpected formats surface visibly rather than silently corrupting.
function toISODate(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  // Already ISO
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  // MM/DD/YYYY or M/D/YYYY
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const [, mm, dd, yyyy] = m;
    return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
  }
  // Raw Excel date serial (days since 1899-12-30) — some cells in this export
  // aren't typed as real dates, so SheetJS falls back to the bare number.
  if (/^\d{4,6}$/.test(s)) {
    const parsed = XLSX.SSF.parse_date_code(Number(s));
    if (parsed) {
      return `${parsed.y}-${String(parsed.m).padStart(2, '0')}-${String(parsed.d).padStart(2, '0')}`;
    }
  }
  console.warn(`  WARNING: unrecognized date format "${s}", stored as-is`);
  return s;
}

const UCC_RAW_COLUMNS = [
  'EASI_COMPANYID', 'BUYER ID', 'COMPANY', 'CUSTOMER NUMBER', 'DBS NAME', 'FILING DATE',
  'MANUFACTURER', 'EQUIPMENT DESCRIPTION', 'SERIAL', 'MODEL',
  'MANUFACTURING YEAR FROM UCC FILING', 'NEW/USED', 'EQUIPMENT OR ATTACHMENT',
  'EQUIPMENT VALUE', 'FIRST NAME', 'LAST NAME', 'PHONE', 'ADDRESS 1', 'ADDRESS 2',
  'CITY', 'ZIP CODE', 'COUNTY', 'Latitude', 'Longitude', 'USER ASSIGNMENT',
  'USER ASSIGNMENT MANAGER', 'SALESMEN 1', 'NEW_UCCSTATUS'
];

const UPSERT_SQL = `INSERT INTO ucc_facts (
  buyer_id, easi_company_id, company, customer_number, dbs_name,
  filing_date, ucc_status, manufacturer, equipment_description, serial, model,
  mfg_year, new_used, equip_or_attach, equipment_value,
  first_name, last_name, phone, address1, address2, city, zip, county, lat, lon,
  user_assignment, user_assignment_mgr, salesmen1,
  load_batch, row_hash, updated_at
) VALUES (?,?,?,?,?, ?,?,?,?,?,?, ?,?,?,?, ?,?,?,?,?,?,?,?,?,?, ?,?,?, ?,?,datetime('now'))
ON CONFLICT(serial, filing_date) DO UPDATE SET
  buyer_id=excluded.buyer_id, easi_company_id=excluded.easi_company_id,
  company=excluded.company, customer_number=excluded.customer_number, dbs_name=excluded.dbs_name,
  ucc_status=excluded.ucc_status, equipment_description=excluded.equipment_description, model=excluded.model,
  mfg_year=excluded.mfg_year, new_used=excluded.new_used, equip_or_attach=excluded.equip_or_attach,
  equipment_value=excluded.equipment_value,
  first_name=excluded.first_name, last_name=excluded.last_name, phone=excluded.phone,
  address1=excluded.address1, address2=excluded.address2, city=excluded.city, zip=excluded.zip,
  county=excluded.county, lat=excluded.lat, lon=excluded.lon,
  user_assignment=excluded.user_assignment, user_assignment_mgr=excluded.user_assignment_mgr,
  salesmen1=excluded.salesmen1, load_batch=excluded.load_batch,
  row_hash=excluded.row_hash, updated_at=excluded.updated_at`;

// Retries a batch write on transient failures (dropped connections, socket resets —
// common on long-running scripts behind a corporate proxy). Recreates the client
// between attempts in case the underlying connection itself is the problem, not
// just a single request.
async function executeBatchWithRetry(batch, maxRetries = 5) {
  let lastErr;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await client.batch(batch, 'write');
      return;
    } catch (err) {
      lastErr = err;
      console.warn(`  batch write failed (attempt ${attempt}/${maxRetries}): ${err.message || err}`);
      if (attempt < maxRetries) {
        const delay = 1000 * Math.pow(2, attempt - 1); // 1s, 2s, 4s, 8s...
        console.warn(`  reconnecting and retrying in ${delay / 1000}s...`);
        await new Promise((res) => setTimeout(res, delay));
        client = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });
      }
    }
  }
  throw lastErr;
}

// Same idea, for single read queries (hash pagination, payload row pagination).
async function executeWithRetry(sql, args, maxRetries = 5) {
  let lastErr;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await client.execute({ sql, args: args || [] });
    } catch (err) {
      lastErr = err;
      console.warn(`  query failed (attempt ${attempt}/${maxRetries}): ${err.message || err}`);
      if (attempt < maxRetries) {
        const delay = 1000 * Math.pow(2, attempt - 1);
        console.warn(`  reconnecting and retrying in ${delay / 1000}s...`);
        await new Promise((res) => setTimeout(res, delay));
        client = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });
      }
    }
  }
  throw lastErr;
}

async function loadExistingHashes() {
  const map = {};
  const countRes = await executeWithRetry('SELECT COUNT(*) as cnt FROM ucc_facts');
  const total = Number(countRes.rows[0]?.cnt || 0);
  if (total === 0) return map;

  const PAGE = 10000;
  for (let offset = 0; offset < total; offset += PAGE) {
    const res = await executeWithRetry(
      'SELECT serial, filing_date, row_hash FROM ucc_facts LIMIT ? OFFSET ?',
      [PAGE, offset]
    );
    res.rows.forEach((r) => {
      const pk = `${r.serial || ''}|${r.filing_date || ''}`;
      map[pk] = String(r.row_hash || '');
    });
    console.log(`  loaded hashes ${Math.min(offset + PAGE, total)} / ${total}`);
  }
  return map;
}

async function main() {
  console.log(`Reading ${path.basename(filePath)}...`);
  const wb = XLSX.readFile(filePath, { cellDates: false });
  const sheet = wb.Sheets['UCC Data'] || wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, dateNF: 'yyyy-mm-dd' });

  const header = rows[0];
  const C = {};
  UCC_RAW_COLUMNS.forEach((col) => { C[col] = header.indexOf(col); });

  console.log(`${rows.length - 1} rows in source file. Loading existing hashes from Turso...`);
  const hashes = await loadExistingHashes();
  console.log(`${Object.keys(hashes).length} existing rows in ucc_facts.`);

  const loadBatch = new Date().toISOString().slice(0, 7); // e.g. '2026-07'
  const stmts = [];
  let skipped = 0;

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.length < 5) continue;

    const serial = String(r[C['SERIAL']] || '').trim();
    const fdate = toISODate(r[C['FILING DATE']]);
    const mfr = String(r[C['MANUFACTURER']] || '').trim();
    if (!serial && !fdate && !mfr) continue;

    const pk = `${serial}|${fdate}`;
    const company = String(r[C['COMPANY']] || '').trim();
    const rep = String(r[C['USER ASSIGNMENT']] || '').trim();
    const repMgr = String(r[C['USER ASSIGNMENT MANAGER']] || '').trim();
    const status = String(r[C['NEW_UCCSTATUS']] || '').trim();
    const model = String(r[C['MODEL']] || '').trim();
    const eqValue = money(r[C['EQUIPMENT VALUE']]);
    const zip = String(r[C['ZIP CODE']] || '').trim();

    const newHash = hashRow([serial, fdate, mfr, model, company, rep, repMgr, status, eqValue, zip]);
    if (hashes[pk] === newHash) { skipped++; continue; }

    stmts.push({
      sql: UPSERT_SQL,
      args: [
        String(r[C['BUYER ID']] || '').trim(),
        String(r[C['EASI_COMPANYID']] || '').trim(),
        company,
        String(r[C['CUSTOMER NUMBER']] || '').trim(),
        String(r[C['DBS NAME']] || '').trim(),
        fdate,
        status,
        mfr,
        String(r[C['EQUIPMENT DESCRIPTION']] || '').trim(),
        serial,
        model,
        String(r[C['MANUFACTURING YEAR FROM UCC FILING']] || '').trim(),
        String(r[C['NEW/USED']] || '').trim(),
        String(r[C['EQUIPMENT OR ATTACHMENT']] || '').trim(),
        eqValue,
        String(r[C['FIRST NAME']] || '').trim(),
        String(r[C['LAST NAME']] || '').trim(),
        String(r[C['PHONE']] || '').trim(),
        String(r[C['ADDRESS 1']] || '').trim(),
        String(r[C['ADDRESS 2']] || '').trim(),
        String(r[C['CITY']] || '').trim(),
        zip,
        String(r[C['COUNTY']] || '').trim(),
        parseFloat(r[C['Latitude']]) || 0,
        parseFloat(r[C['Longitude']]) || 0,
        rep,
        repMgr,
        String(r[C['SALESMEN 1']] || '').trim(),
        loadBatch,
        newHash
      ]
    });
  }

  console.log(`${stmts.length} rows to upsert, ${skipped} unchanged.`);

  const BATCH = 500;
  let upserted = 0;
  for (let bi = 0; bi < stmts.length; bi += BATCH) {
    const batch = stmts.slice(bi, bi + BATCH);
    // Sequential per-batch (not parallel fan-out) — matches the lesson learned from
    // Sales Funnel's loader running behind Connor's corporate TLS-inspecting proxy.
    await executeBatchWithRetry(batch);
    upserted += batch.length;
    console.log(`  upserted ${upserted} / ${stmts.length}`);
  }

  console.log(`Done. Upserted ${upserted} rows, ${skipped} unchanged, load_batch=${loadBatch}.`);

  await buildPayload();
}

// ── Precompute the full dashboard payload as a single gzip blob ─────────
// This is what makes the dashboard instant: instead of the browser (or a
// Netlify function) re-querying/re-aggregating 89K+ rows on every filter
// change, we ship the whole flat dataset once, and all filtering happens
// client-side in memory. Same pattern as PINS/Sales Funnel's precompute step.
async function buildPayload() {
  console.log('Building dashboard payload...');
  const countRes = await executeWithRetry('SELECT COUNT(*) as cnt FROM ucc_facts');
  const total = Number(countRes.rows[0]?.cnt || 0);

  const fetchCols = [
    'company', 'filing_date', 'ucc_status', 'manufacturer', 'equipment_description',
    'model', 'serial', 'new_used', 'equipment_value', 'county', 'city',
    'user_assignment', 'salesmen1', 'buyer_id', 'customer_number'
  ];

  // Fetch as objects during this pass (easier to compute derived fields against);
  // converted to the compact array-of-arrays form at the end for transmission.
  const allRows = [];
  const PAGE = 10000;
  for (let offset = 0; offset < total; offset += PAGE) {
    const res = await executeWithRetry(
      `SELECT ${fetchCols.join(',')} FROM ucc_facts LIMIT ? OFFSET ?`,
      [PAGE, offset]
    );
    res.rows.forEach((r) => {
      const obj = {};
      fetchCols.forEach((c) => { obj[c] = r[c]; });
      allRows.push(obj);
    });
    console.log(`  read ${Math.min(offset + PAGE, total)} / ${total} for payload`);
  }

  computeDerivedFields(allRows);

  const cols = fetchCols.concat(['new_existing', 'sales_count_5yr', 'sales_bucket', 'known_unknown']);
  const rowArrays = allRows.map((r) => cols.map((c) => r[c]));

  const payload = { columns: cols, rows: rowArrays, generated_at: new Date().toISOString() };
  const json = JSON.stringify(payload);
  const gz = zlib.gzipSync(Buffer.from(json, 'utf-8'));
  const b64 = gz.toString('base64');

  await executeWithRetry(
    `CREATE TABLE IF NOT EXISTS ucc_payload (
      id INTEGER PRIMARY KEY,
      data TEXT NOT NULL,
      row_count INTEGER,
      updated_at TEXT
    )`
  );
  await executeWithRetry(
    `INSERT INTO ucc_payload (id, data, row_count, updated_at) VALUES (1, ?, ?, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET data=excluded.data, row_count=excluded.row_count, updated_at=excluded.updated_at`,
    [b64, rowArrays.length]
  );

  console.log(`Payload built: ${rowArrays.length} rows, ${(json.length/1024/1024).toFixed(1)}MB raw -> ${(gz.length/1024/1024).toFixed(2)}MB gzipped.`);
}

// ── Derived company-analysis fields (Tab 2) ──────────────────────────────
// These are computed once here, against the FULL unfiltered purchase history,
// so they stay stable regardless of whatever filters are active on the
// dashboard later — a customer's New/Existing status shouldn't flip just
// because someone filtered to a specific manufacturer.
//
//   new_existing    — per row/transaction. "New" if it's the buyer's first-ever
//                     purchase, OR if the gap since their previous purchase is
//                     >= 5 years (a dormant customer resurfacing counts as new).
//                     Otherwise "Existing".
//   sales_count_5yr — per buyer_id, static: count of that buyer's purchases
//                     (rows) within the last 5 years of the dataset's latest
//                     filing date (not real "today").
//   sales_bucket    — sales_count_5yr bucketed into '1' / '2-5' / '5+'.
//   known_unknown   — per row: "Known" if customer_number is populated
//                     (matched to our ERP/DBS), else "Unknown".
function computeDerivedFields(allRows) {
  console.log('Computing derived fields (new/existing, sales buckets, known/unknown)...');

  let anchor = '0000-00-00';
  allRows.forEach((r) => { if (r.filing_date && r.filing_date > anchor) anchor = r.filing_date; });
  const anchorD = new Date(anchor + 'T00:00:00');
  const fiveYearsAgo = new Date(anchorD);
  fiveYearsAgo.setFullYear(fiveYearsAgo.getFullYear() - 5);
  const fiveYearCutoff = fiveYearsAgo.toISOString().slice(0, 10);

  // Group row indices by buyer_id
  const byBuyer = new Map();
  allRows.forEach((r, idx) => {
    const bid = (r.buyer_id || '').trim();
    if (!bid) return;
    if (!byBuyer.has(bid)) byBuyer.set(bid, []);
    byBuyer.get(bid).push(idx);
  });

  const FIVE_YEARS_MS = 5 * 365.25 * 24 * 3600 * 1000;

  byBuyer.forEach((idxs, bid) => {
    idxs.sort((a, b) => {
      const da = allRows[a].filing_date || '';
      const db = allRows[b].filing_date || '';
      return da < db ? -1 : da > db ? 1 : 0;
    });

    let prevDate = null;
    idxs.forEach((idx) => {
      const fd = allRows[idx].filing_date;
      if (!fd) { allRows[idx].new_existing = ''; return; }
      const d = new Date(fd + 'T00:00:00');
      if (prevDate === null) {
        allRows[idx].new_existing = 'New';
      } else {
        const gapMs = d - prevDate;
        allRows[idx].new_existing = gapMs >= FIVE_YEARS_MS ? 'New' : 'Existing';
      }
      prevDate = d;
    });

    const count5yr = idxs.filter((idx) => allRows[idx].filing_date && allRows[idx].filing_date >= fiveYearCutoff).length;
    const bucket = count5yr <= 1 ? '1' : count5yr <= 5 ? '2-5' : '5+';
    idxs.forEach((idx) => {
      allRows[idx].sales_count_5yr = count5yr;
      allRows[idx].sales_bucket = bucket;
    });
  });

  // Rows with no buyer_id can't get a buyer-grouped designation
  allRows.forEach((r) => {
    if (r.new_existing === undefined) r.new_existing = '';
    if (r.sales_count_5yr === undefined) r.sales_count_5yr = '';
    if (r.sales_bucket === undefined) r.sales_bucket = '';
    r.known_unknown = (r.customer_number && String(r.customer_number).trim()) ? 'Known' : 'Unknown';
  });

  console.log(`Derived fields computed. Anchor date: ${anchor}, 5yr cutoff: ${fiveYearCutoff}, ${byBuyer.size} distinct buyer IDs.`);
}

main().catch((err) => {
  console.error('Load failed:', err);
  process.exit(1);
});
