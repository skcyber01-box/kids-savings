// Vercel Serverless Function: POST /api/count
// รับรูปเงิน (base64 JPEG) แล้วให้ Claude นับเหรียญ/ธนบัตรไทย
// ต้องตั้ง env ANTHROPIC_API_KEY (สร้างได้ที่ console.anthropic.com)

const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';
const VALID = [1, 2, 5, 10, 20, 50, 100, 500, 1000];

const PROMPT = `นี่คือรูปถ่ายเงินไทยที่เด็กกำลังนับเพื่อบันทึกเงินออม
ให้นับเหรียญและธนบัตรไทยทุกชิ้นที่เห็นในรูป
- เหรียญ: 1, 2, 5, 10 บาท (ถ้ามีเหรียญสตางค์ 25 หรือ 50 สตางค์ ไม่ต้องนับรวม แต่ให้บอกใน note)
- ธนบัตร: 20, 50, 100, 500, 1000 บาท
- ระวังเหรียญ 1 บาทกับ 2 บาทที่คล้ายกัน (เหรียญ 2 บาทรุ่นใหม่สีทอง) และเหรียญที่ซ้อนกัน
- ถ้ารูปไม่มีเงิน หรือมองไม่ชัด ให้ items เป็น [] และอธิบายใน note

ตอบเป็น JSON อย่างเดียว ไม่มีข้อความอื่น ตามรูปแบบนี้:
{"items":[{"value":10,"count":3}],"confidence":"high","note":"ข้อความสั้นๆ ภาษาไทยสำหรับเด็ก"}
confidence ใช้ "high", "medium" หรือ "low"`;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'method-not-allowed' }); }

  const familyKey = process.env.FAMILY_KEY;
  if (familyKey && req.headers['x-family-key'] !== familyKey) return res.status(401).json({ error: 'family-key-required' });
  if (!API_KEY) return res.status(503).json({ error: 'ai-not-configured' });

  try {
    let body = req.body;
    if (typeof body === 'string') body = JSON.parse(body || '{}');
    const image = body && body.image;
    const mediaType = (body && body.mediaType) || 'image/jpeg';
    if (typeof image !== 'string' || image.length < 100) return res.status(400).json({ error: 'no-image' });
    if (image.length > 4_000_000) return res.status(413).json({ error: 'image-too-large' });
    if (!/^image\/(jpeg|png|webp)$/.test(mediaType)) return res.status(400).json({ error: 'bad-type' });

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 600,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: image } },
          { type: 'text', text: PROMPT },
        ] }],
      }),
    });
    const j = await r.json();
    if (!r.ok) return res.status(502).json({ error: 'ai-error', detail: j?.error?.message || `HTTP ${r.status}` });

    const text = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return res.status(502).json({ error: 'ai-bad-response' });
    const parsed = JSON.parse(match[0]);

    // รวมรายการซ้ำ และกรองเฉพาะมูลค่าเงินไทยที่ถูกต้อง
    const map = new Map();
    for (const it of Array.isArray(parsed.items) ? parsed.items : []) {
      const v = Math.round(+it.value), c = Math.round(+it.count);
      if (VALID.includes(v) && c > 0 && c < 1000) map.set(v, (map.get(v) || 0) + c);
    }
    const items = [...map.entries()].sort((a, b) => b[0] - a[0]).map(([value, count]) => ({ value, count }));
    const total = items.reduce((s, it) => s + it.value * it.count, 0);
    const confidence = ['high', 'medium', 'low'].includes(parsed.confidence) ? parsed.confidence : 'medium';

    return res.status(200).json({ items, total, confidence, note: String(parsed.note || '').slice(0, 200) });
  } catch (e) {
    return res.status(500).json({ error: 'server-error', detail: String((e && e.message) || e) });
  }
}
