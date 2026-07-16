// netlify/functions/ucc-payload.mjs
// Serves the precomputed dashboard payload built by load.js's buildPayload() step.
// This is the whole point of the precompute pattern: this function does ONE tiny
// read (a single row) and some in-memory decompression — no aggregation queries
// against the 89K+ row table on every dashboard load/filter change.

import { createClient } from '@libsql/client/web';
import zlib from 'zlib';

const client = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN
});

export default async (req) => {
  try {
    const res = await client.execute('SELECT data FROM ucc_payload WHERE id = 1');
    const row = res.rows[0];
    if (!row) {
      return new Response(JSON.stringify({ error: 'No payload found — run load.js first.' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const gz = Buffer.from(row.data, 'base64');
    const json = zlib.gunzipSync(gz).toString('utf-8');

    return new Response(json, {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    console.error('ucc-payload error:', err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

export const config = { path: '/api/ucc-payload' };
