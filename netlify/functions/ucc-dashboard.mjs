// netlify/functions/ucc-dashboard.mjs
// Read-only query endpoint for the UCCs dashboard tabs. Turso credentials stay server-side.
//
// Modes:
//   ?mode=facets                            -> distinct values for filter dropdowns
//   ?mode=pins_overview&<filters>           -> tiles (CAT/Industry/PINS%) + by_county +
//                                              by_equipment + by_manufacturer, all respecting filters
//   ?mode=search&<filters>&limit=&offset=   -> paginated raw rows (also used for full export, looped client-side)
//
// Shared filters (all optional): date_from, date_to, salesmen1, manufacturer, company,
// equipment_description, ucc_status, new_used

import { createClient } from '@libsql/client/web';

const client = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN
});

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

// Builds a WHERE clause + args array from the shared filter set.
function buildFilters(params) {
  const where = [];
  const args = [];

  if (params.get('date_from')) { where.push('filing_date >= ?'); args.push(params.get('date_from')); }
  if (params.get('date_to')) { where.push('filing_date <= ?'); args.push(params.get('date_to')); }
  if (params.get('salesmen1')) { where.push('salesmen1 = ?'); args.push(params.get('salesmen1')); }
  if (params.get('manufacturer')) { where.push('manufacturer = ?'); args.push(params.get('manufacturer')); }
  if (params.get('company')) { where.push('company LIKE ?'); args.push('%' + params.get('company') + '%'); }
  if (params.get('equipment_description')) { where.push('equipment_description = ?'); args.push(params.get('equipment_description')); }
  if (params.get('ucc_status')) { where.push('ucc_status = ?'); args.push(params.get('ucc_status')); }
  if (params.get('new_used')) { where.push('new_used = ?'); args.push(params.get('new_used')); }

  return { whereSql: where.length ? 'WHERE ' + where.join(' AND ') : '', args };
}

async function getFacets() {
  const [manufacturers, counties, statuses, salesmen, equipment, newUsed] = await Promise.all([
    client.execute(`SELECT DISTINCT manufacturer FROM ucc_facts WHERE manufacturer IS NOT NULL AND manufacturer != '' ORDER BY manufacturer`),
    client.execute(`SELECT DISTINCT county FROM ucc_facts WHERE county IS NOT NULL AND county != '' ORDER BY county`),
    client.execute(`SELECT DISTINCT ucc_status FROM ucc_facts WHERE ucc_status IS NOT NULL AND ucc_status != '' ORDER BY ucc_status`),
    client.execute(`SELECT DISTINCT salesmen1 FROM ucc_facts WHERE salesmen1 IS NOT NULL AND salesmen1 != '' ORDER BY salesmen1`),
    client.execute(`SELECT DISTINCT equipment_description FROM ucc_facts WHERE equipment_description IS NOT NULL AND equipment_description != '' ORDER BY equipment_description`),
    client.execute(`SELECT DISTINCT new_used FROM ucc_facts WHERE new_used IS NOT NULL AND new_used != '' ORDER BY new_used`)
  ]);
  return {
    manufacturers: manufacturers.rows.map(r => r.manufacturer),
    counties: counties.rows.map(r => r.county),
    statuses: statuses.rows.map(r => r.ucc_status),
    salesmen: salesmen.rows.map(r => r.salesmen1),
    equipment_descriptions: equipment.rows.map(r => r.equipment_description),
    new_used: newUsed.rows.map(r => r.new_used)
  };
}

async function getPinsOverview(params) {
  const { whereSql, args } = buildFilters(params);
  const countyWhere = whereSql ? `${whereSql} AND county IS NOT NULL AND county != ''` : `WHERE county IS NOT NULL AND county != ''`;
  const equipWhere = whereSql ? `${whereSql} AND equipment_description IS NOT NULL AND equipment_description != ''` : `WHERE equipment_description IS NOT NULL AND equipment_description != ''`;
  const mfrWhere = whereSql ? `${whereSql} AND manufacturer IS NOT NULL AND manufacturer != ''` : `WHERE manufacturer IS NOT NULL AND manufacturer != ''`;

  // Single batched round-trip instead of 4 separate queries — each .execute() call
  // over the HTTP transport pays its own network round-trip, which is the dominant
  // cost here, not the query execution itself against an already-indexed table.
  const results = await client.batch([
    { sql: `SELECT COUNT(*) AS industry, SUM(CASE WHEN manufacturer = 'CAT' THEN 1 ELSE 0 END) AS cat FROM ucc_facts ${whereSql}`, args },
    { sql: `SELECT county, COUNT(*) AS industry, SUM(CASE WHEN manufacturer = 'CAT' THEN 1 ELSE 0 END) AS cat FROM ucc_facts ${countyWhere} GROUP BY county ORDER BY county`, args },
    { sql: `SELECT equipment_description, COUNT(*) AS industry, SUM(CASE WHEN manufacturer = 'CAT' THEN 1 ELSE 0 END) AS cat FROM ucc_facts ${equipWhere} GROUP BY equipment_description ORDER BY industry DESC`, args },
    { sql: `SELECT manufacturer, COUNT(*) AS total FROM ucc_facts ${mfrWhere} GROUP BY manufacturer ORDER BY total DESC`, args }
  ], 'read');

  const [tiles, byCounty, byEquipment, byManufacturer] = results;

  const t = tiles.rows[0] || { industry: 0, cat: 0 };
  const industryTotal = Number(t.industry || 0);
  const catTotal = Number(t.cat || 0);

  return {
    tiles: {
      cat: catTotal,
      industry: industryTotal,
      pins_pct: industryTotal ? Math.round(1000 * catTotal / industryTotal) / 10 : 0
    },
    by_county: byCounty.rows.map(r => {
      const ind = Number(r.industry || 0);
      const cat = Number(r.cat || 0);
      return { county: r.county, cat, industry: ind, pins_pct: ind ? Math.round(1000 * cat / ind) / 10 : 0 };
    }),
    by_equipment: byEquipment.rows.map(r => {
      const ind = Number(r.industry || 0);
      const cat = Number(r.cat || 0);
      return { equipment_description: r.equipment_description, cat, industry: ind, pins_pct: ind ? Math.round(1000 * cat / ind) / 10 : 0 };
    }),
    // Manufacturer PINS here = that manufacturer's share of total industry volume (not CAT/industry)
    by_manufacturer: byManufacturer.rows.map(r => {
      const total = Number(r.total || 0);
      return { manufacturer: r.manufacturer, total, pins_pct: industryTotal ? Math.round(1000 * total / industryTotal) / 10 : 0 };
    })
  };
}

async function getSearch(params) {
  const { whereSql, args } = buildFilters(params);
  const limit = Math.min(parseInt(params.get('limit') || '50', 10), 5000);
  const offset = parseInt(params.get('offset') || '0', 10);

  const [countRes, rowsRes] = await client.batch([
    { sql: `SELECT COUNT(*) AS cnt FROM ucc_facts ${whereSql}`, args },
    {
      sql: `SELECT company, filing_date, ucc_status, manufacturer, equipment_description, model,
                   serial, new_used, mfg_year, equipment_value, county, city, zip,
                   user_assignment, salesmen1
            FROM ucc_facts ${whereSql}
            ORDER BY filing_date DESC
            LIMIT ? OFFSET ?`,
      args: [...args, limit, offset]
    }
  ], 'read');

  return { total: Number(countRes.rows[0]?.cnt || 0), rows: rowsRes.rows };
}

export default async (req) => {
  try {
    const url = new URL(req.url);
    const mode = url.searchParams.get('mode') || 'pins_overview';

    if (mode === 'facets') return json(await getFacets());
    if (mode === 'pins_overview') return json(await getPinsOverview(url.searchParams));
    if (mode === 'search') return json(await getSearch(url.searchParams));

    return json({ error: 'unknown mode' }, 400);
  } catch (err) {
    console.error('ucc-dashboard error:', err);
    return json({ error: err.message }, 500);
  }
};

export const config = { path: '/api/ucc-dashboard' };
