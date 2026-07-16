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

const client = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });

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
ON CONFLICT(serial, filing_date, manufacturer) DO UPDATE SET
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

async function loadExistingHashes() {
  const map = {};
  const countRes = await client.execute('SELECT COUNT(*) as cnt FROM ucc_facts');
  const total = Number(countRes.rows[0]?.cnt || 0);
  if (total === 0) return map;

  const PAGE = 10000;
  for (let offset = 0; offset < total; offset += PAGE) {
    const res = await client.execute({
      sql: 'SELECT serial, filing_date, manufacturer, row_hash FROM ucc_facts LIMIT ? OFFSET ?',
      args: [PAGE, offset]
    });
    res.rows.forEach((r) => {
      const pk = `${r.serial || ''}|${r.filing_date || ''}|${r.manufacturer || ''}`;
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

    const pk = `${serial}|${fdate}|${mfr}`;
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
    await client.batch(batch, 'write');
    upserted += batch.length;
    console.log(`  upserted ${upserted} / ${stmts.length}`);
  }

  console.log(`Done. Upserted ${upserted} rows, ${skipped} unchanged, load_batch=${loadBatch}.`);
}

main().catch((err) => {
  console.error('Load failed:', err);
  process.exit(1);
});
