// netlify/functions/ucc-upsert.mjs
// Accepts { batch: [ {buyer_id, easi_company_id, company, ..., row_hash, load_batch}, ... ] }
// Upserts one batch (client controls batch size, e.g. 300-500 rows per call, to stay
// under the 10s Netlify function timeout). Client loops, calling this repeatedly.

import { createClient } from '@libsql/client/web';

const client = createClient({
  url: process.env.SALES_FUNNEL_TURSO_URL,
  authToken: process.env.SALES_FUNNEL_TURSO_TOKEN
});

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

function row(r) {
  return [
    r.buyer_id, r.easi_company_id, r.company, r.customer_number, r.dbs_name,
    r.filing_date, r.ucc_status, r.manufacturer, r.equipment_description, r.serial, r.model,
    r.mfg_year, r.new_used, r.equip_or_attach, r.equipment_value,
    r.first_name, r.last_name, r.phone, r.address1, r.address2, r.city, r.zip, r.county, r.lat, r.lon,
    r.user_assignment, r.user_assignment_mgr, r.salesmen1,
    r.load_batch, r.row_hash
  ];
}

export default async (req) => {
  try {
    if (req.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'POST only' }), { status: 405 });
    }
    const { batch } = await req.json();
    if (!Array.isArray(batch) || batch.length === 0) {
      return new Response(JSON.stringify({ upserted: 0 }), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      });
    }

    // Single round-trip batch write. (The "sequential over parallel" lesson from other
    // loaders applies to scripts running behind Connor's corporate TLS-inspecting proxy —
    // this executes server-side in the Netlify function, talking to Turso directly, so a
    // single batched write is safe and much faster than one round-trip per row.)
    await client.batch(
      batch.map((r) => ({ sql: UPSERT_SQL, args: row(r) })),
      'write'
    );

    return new Response(JSON.stringify({ upserted: batch.length }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    console.error('ucc-upsert error:', err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

export const config = { path: '/api/ucc-upsert' };
