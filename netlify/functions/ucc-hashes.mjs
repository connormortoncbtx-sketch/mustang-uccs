// netlify/functions/ucc-hashes.mjs
// Returns { total, rows: [{serial, filing_date, manufacturer, row_hash}, ...] } for a page.
// Client paginates via ?offset=&limit= to stay under response-size limits.
// Uses server-side env vars only — Turso credentials never reach the browser.

import { createClient } from '@libsql/client/web';

const client = createClient({
  url: process.env.SALES_FUNNEL_TURSO_URL,
  authToken: process.env.SALES_FUNNEL_TURSO_TOKEN
});

export default async (req) => {
  try {
    const url = new URL(req.url);
    const offset = parseInt(url.searchParams.get('offset') || '0', 10);
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '20000', 10), 20000);

    const countRes = await client.execute('SELECT COUNT(*) as cnt FROM ucc_facts');
    const total = Number(countRes.rows[0]?.cnt || 0);

    const rowsRes = await client.execute({
      sql: 'SELECT serial, filing_date, manufacturer, row_hash FROM ucc_facts LIMIT ? OFFSET ?',
      args: [limit, offset]
    });

    return new Response(JSON.stringify({ total, rows: rowsRes.rows }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    console.error('ucc-hashes error:', err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

export const config = { path: '/api/ucc-hashes' };
