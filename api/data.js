// Vercel Serverless Function: GET/PUT /api/data
// เก็บข้อมูลทั้งหมดของครอบครัวเป็น JSON ก้อนเดียวใน Upstash Redis
// รองรับ env ทั้งแบบ KV_REST_API_* (ที่ Vercel ตั้งให้อัตโนมัติ) และ UPSTASH_REDIS_REST_*

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const KEY = process.env.STATE_KEY || 'kids-savings:state';
const MAX_BYTES = 900_000;

async function redis(command) {
  const r = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  });
  const j = await r.json();
  if (!r.ok || j.error) throw new Error(j.error || `Redis HTTP ${r.status}`);
  return j.result;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (!REDIS_URL || !REDIS_TOKEN) {
    return res.status(503).json({ error: 'storage-not-configured' });
  }

  // ถ้าตั้ง FAMILY_KEY ไว้ ทุกคำขอต้องแนบรหัสครอบครัวมาด้วย
  const familyKey = process.env.FAMILY_KEY;
  if (familyKey && req.headers['x-family-key'] !== familyKey) {
    return res.status(401).json({ error: 'family-key-required' });
  }

  try {
    if (req.method === 'GET') {
      const raw = await redis(['GET', KEY]);
      return res.status(200).json({ state: raw ? JSON.parse(raw) : null });
    }

    if (req.method === 'PUT' || req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') body = JSON.parse(body || '{}');
      const state = body && body.state;
      if (!state || typeof state !== 'object' || !Array.isArray(state.tx) || !Array.isArray(state.kids)) {
        return res.status(400).json({ error: 'invalid-state' });
      }
      const raw = JSON.stringify(state);
      if (Buffer.byteLength(raw) > MAX_BYTES) return res.status(413).json({ error: 'too-large' });

      await redis(['SET', KEY, raw]);
      // สำรองข้อมูลรายวัน เก็บไว้ 90 วัน
      const day = new Date().toISOString().slice(0, 10);
      await redis(['SET', `${KEY}:backup:${day}`, raw, 'EX', String(60 * 60 * 24 * 90)]);

      return res.status(200).json({ ok: true, savedAt: new Date().toISOString() });
    }

    res.setHeader('Allow', 'GET, PUT');
    return res.status(405).json({ error: 'method-not-allowed' });
  } catch (e) {
    return res.status(500).json({ error: 'server-error', detail: String((e && e.message) || e) });
  }
}
