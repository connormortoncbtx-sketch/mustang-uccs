// ============================================================
// UCCs tool — loader (client-side)
// Talks to /api/ucc-hashes and /api/ucc-upsert Netlify functions.
// No Turso credentials in this file — they live server-side only,
// in the Netlify functions' SALES_FUNNEL_TURSO_URL / _TOKEN env vars.
// Requires SheetJS (XLSX) loaded on the page:
// <script src="https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js"></script>
// ============================================================

// ── Hashing (identical to ExcaVision's hashStr/hashRow, for consistency) ──
function hashStr(str) {
  var hash = 5381;
  for (var i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i);
    hash = hash & hash;
  }
  return (hash >>> 0).toString(36);
}
function hashRow(fields) {
  return hashStr(fields.map(function (f) { return String(f == null ? '' : f); }).join('|'));
}

// ── Fetch all existing hashes, paginated ──────────────────────────────────
async function loadExistingHashes(log) {
  var map = {};
  var offset = 0;
  var limit = 20000;
  var total = null;

  while (total === null || offset < total) {
    var resp = await fetch('/api/ucc-hashes?offset=' + offset + '&limit=' + limit);
    if (!resp.ok) throw new Error('ucc-hashes error: ' + resp.status);
    var data = await resp.json();
    if (data.error) throw new Error(data.error);
    total = data.total;
    data.rows.forEach(function (r) {
      var pk = String(r.serial || '') + '|' + String(r.filing_date || '') + '|' + String(r.manufacturer || '');
      map[pk] = String(r.row_hash || '');
    });
    log('Loaded ' + Math.min(offset + limit, total) + ' / ' + total + ' existing hashes', 'ok');
    offset += limit;
  }
  return map;
}

// ── Raw column headers (exact match to the UCC_2015-Current.xlsx export) ─
var UCC_RAW_COLUMNS = [
  'EASI_COMPANYID', 'BUYER ID', 'COMPANY', 'CUSTOMER NUMBER', 'DBS NAME', 'FILING DATE',
  'MANUFACTURER', 'EQUIPMENT DESCRIPTION', 'SERIAL', 'MODEL',
  'MANUFACTURING YEAR FROM UCC FILING', 'NEW/USED', 'EQUIPMENT OR ATTACHMENT',
  'EQUIPMENT VALUE', 'FIRST NAME', 'LAST NAME', 'PHONE', 'ADDRESS 1', 'ADDRESS 2',
  'CITY', 'ZIP CODE', 'COUNTY', 'Latitude', 'Longitude', 'USER ASSIGNMENT',
  'USER ASSIGNMENT MANAGER', 'SALESMEN 1', 'NEW_UCCSTATUS'
];

function money(v) {
  var sv = String(v || 0).replace(/[$,]/g, '');
  return parseFloat(sv) || 0;
}

// ── Main: parse an uploaded workbook's rows and upsert via Netlify function ──
// `rows` = XLSX.utils.sheet_to_json(sheet, {header:1, raw:false, dateNF:'yyyy-mm-dd'}) output
// `loadBatch` = e.g. '2026-07', stamps which monthly refresh touched each row
// `log` = function(msg, type) for UI progress logging (optional, no-op if omitted)
async function loadUccFacts(rows, loadBatch, log) {
  log = log || function () {};
  var header = rows[0];
  var C = {};
  UCC_RAW_COLUMNS.forEach(function (col) { C[col] = header.indexOf(col); });

  log('Loading existing UCC hashes...', 'info');
  var hashes = await loadExistingHashes(log);
  log(Object.keys(hashes).length + ' existing rows in ucc_facts', 'ok');

  var changed = [];
  var skipped = 0;

  for (var i = 1; i < rows.length; i++) {
    var r = rows[i];
    if (!r || r.length < 5) continue;

    var serial = String(r[C['SERIAL']] || '').trim();
    var fdate = String(r[C['FILING DATE']] || '').split('T')[0].split(' ')[0];
    var mfr = String(r[C['MANUFACTURER']] || '').trim();
    if (!serial && !fdate && !mfr) continue;

    var pk = serial + '|' + fdate + '|' + mfr;
    var company = String(r[C['COMPANY']] || '').trim();
    var rep = String(r[C['USER ASSIGNMENT']] || '').trim();
    var repMgr = String(r[C['USER ASSIGNMENT MANAGER']] || '').trim();
    var status = String(r[C['NEW_UCCSTATUS']] || '').trim();
    var model = String(r[C['MODEL']] || '').trim();
    var eqValue = money(r[C['EQUIPMENT VALUE']]);
    var zip = String(r[C['ZIP CODE']] || '').trim();

    var newHash = hashRow([serial, fdate, mfr, model, company, rep, repMgr, status, eqValue, zip]);
    if (hashes[pk] === newHash) { skipped++; continue; }

    changed.push({
      buyer_id: String(r[C['BUYER ID']] || '').trim(),
      easi_company_id: String(r[C['EASI_COMPANYID']] || '').trim(),
      company: company,
      customer_number: String(r[C['CUSTOMER NUMBER']] || '').trim(),
      dbs_name: String(r[C['DBS NAME']] || '').trim(),
      filing_date: fdate,
      ucc_status: status,
      manufacturer: mfr,
      equipment_description: String(r[C['EQUIPMENT DESCRIPTION']] || '').trim(),
      serial: serial,
      model: model,
      mfg_year: String(r[C['MANUFACTURING YEAR FROM UCC FILING']] || '').trim(),
      new_used: String(r[C['NEW/USED']] || '').trim(),
      equip_or_attach: String(r[C['EQUIPMENT OR ATTACHMENT']] || '').trim(),
      equipment_value: eqValue,
      first_name: String(r[C['FIRST NAME']] || '').trim(),
      last_name: String(r[C['LAST NAME']] || '').trim(),
      phone: String(r[C['PHONE']] || '').trim(),
      address1: String(r[C['ADDRESS 1']] || '').trim(),
      address2: String(r[C['ADDRESS 2']] || '').trim(),
      city: String(r[C['CITY']] || '').trim(),
      zip: zip,
      county: String(r[C['COUNTY']] || '').trim(),
      lat: parseFloat(r[C['Latitude']]) || 0,
      lon: parseFloat(r[C['Longitude']]) || 0,
      user_assignment: rep,
      user_assignment_mgr: repMgr,
      salesmen1: String(r[C['SALESMEN 1']] || '').trim(),
      load_batch: loadBatch || '',
      row_hash: newHash
    });
  }

  log(changed.length + ' rows to upsert, ' + skipped + ' unchanged', 'info');

  var BATCH = 400; // keep well under the 10s Netlify function timeout per call
  var upserted = 0;
  for (var bi = 0; bi < changed.length; bi += BATCH) {
    var batch = changed.slice(bi, bi + BATCH);
    var retries = 0;
    while (retries < 3) {
      try {
        var resp = await fetch('/api/ucc-upsert', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ batch: batch })
        });
        var data = await resp.json();
        if (!resp.ok || data.error) throw new Error(data.error || ('HTTP ' + resp.status));
        upserted += data.upserted;
        log('UCC facts: ' + upserted + ' / ' + changed.length + ' upserted', 'ok');
        break;
      } catch (e) {
        retries++;
        if (retries < 3) {
          log('Retry ' + retries + '... (' + e.message + ')', 'warn');
          await new Promise(function (res) { setTimeout(res, 2000 * retries); });
        } else {
          log('Batch error: ' + e.message, 'warn');
          break;
        }
      }
    }
    if (bi + BATCH < changed.length) {
      await new Promise(function (res) { setTimeout(res, 200); });
    }
  }

  log('Upserted ' + upserted + ' UCC fact rows (' + skipped + ' unchanged)', 'ok');
  return { upserted: upserted, skipped: skipped, total: changed.length };
}

// ============================================================
// Wiring notes:
// 1. Deploy netlify/functions/ucc-hashes.mjs and ucc-upsert.mjs alongside funnel.mjs.
// 2. Set SALES_FUNNEL_TURSO_URL / SALES_FUNNEL_TURSO_TOKEN as Netlify env vars
//    (reuse the same values funnel.mjs already uses, under whatever names it
//    currently expects — rename here to match if it's not these exact names).
// 3. Run the ucc_facts_schema.sql CREATE TABLE statement once against the
//    sales-funnel Turso DB (via the Turso dashboard SQL console) before first upload.
// 4. On upload: parse .xlsx via SheetJS, same as ExcaVision's fileChosen() handler,
//    then call:
//      var rows = XLSX.utils.sheet_to_json(sheet, {header:1, raw:false, dateNF:'yyyy-mm-dd'});
//      await loadUccFacts(rows, '2026-07', function(msg,type){ log(msg,type); });
// ============================================================
