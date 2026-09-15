/**
 * Delivery terms.
 *
 * The agent needs these at the exact moment a customer is deciding, so they
 * live in the cached system prompt rather than behind a tool call — one fewer
 * round trip at the most expensive moment in the conversation.
 *
 * There is also a lookup tool, because a customer who names their province
 * deserves a straight answer about their province, not the whole table.
 */
const db = require('./database');
const state = require('./state');

const TTL = 5 * 60 * 1000;
let cache = { at: 0, zones: [], terms: '' };

function norm(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/đ/gi, 'd').toLowerCase();
}

const money = (n) => Number(n || 0).toLocaleString('vi') + 'đ';

async function refresh() {
  if (!db.DB_ENABLED) return cache;
  try {
    const r = await db.pool.query(
      `SELECT name, keywords, fee, free_from, eta, note
       FROM shipping_zones WHERE is_active = TRUE ORDER BY sort_order, name`
    );
    cache = {
      at: Date.now(),
      zones: r.rows,
      terms: (await state.get('shipping_terms')) || '',
    };
  } catch (e) {
    if (!/shipping_zones/.test(e.message)) {
      console.warn('Shipping refresh failed:', e.message);
    }
  }
  return cache;
}

function touch() {
  if (Date.now() - cache.at > TTL) refresh().catch(() => {});
}

/** Block injected into the cached half of the system prompt. */
function promptBlock() {
  touch();
  if (!cache.zones.length && !cache.terms) return '';

  const lines = cache.zones.map(z => {
    const free = z.free_from ? `, miễn phí ship từ ${money(z.free_from)}` : '';
    return `- ${z.name}: ${money(z.fee)}${free}${z.eta ? `, ${z.eta}` : ''}` +
           `${z.note ? ` (${z.note})` : ''}`;
  });

  return `

GIAO HÀNG — đây là thông tin chính thức, trả lời thẳng, đừng bảo khách chờ farm hỏi lại:
${lines.join('\n')}
${cache.terms ? '\n' + cache.terms : ''}

Khách hỏi phí ship mà chưa nói ở đâu thì hỏi lại đúng một câu: "Mình ở khu vực nào ạ?"
Không bịa phí, không hứa nhanh hơn bảng trên, không tự ý miễn phí ship.`;
}

/** Match a free-text place name to a zone. */
function findZone(place) {
  touch();
  const p = norm(place);
  if (!p) return null;
  for (const z of cache.zones) {
    const keys = norm(z.keywords || '').split(',').map(s => s.trim()).filter(Boolean);
    if (keys.some(k => p.includes(k) || k.includes(p))) return z;
    if (norm(z.name).includes(p)) return z;
  }
  // Fall back to the catch-all zone if one is configured.
  return cache.zones[cache.zones.length - 1] || null;
}

/** Tool result: what this customer pays, for their place, on this basket. */
function quote(place, orderTotal = 0) {
  const z = findZone(place);
  if (!z) return 'Chưa có bảng phí giao hàng. Nói thật là farm sẽ báo lại phí ship.';

  const free = z.free_from && Number(orderTotal) >= Number(z.free_from);
  const parts = [`Khu vực: ${z.name}`];
  parts.push(free
    ? `Phí giao: miễn phí (đơn từ ${money(z.free_from)})`
    : `Phí giao: ${money(z.fee)}`);
  if (!free && z.free_from) {
    const need = Number(z.free_from) - Number(orderTotal || 0);
    if (need > 0 && orderTotal > 0) {
      parts.push(`Mua thêm ${money(need)} nữa là được miễn phí ship.`);
    } else {
      parts.push(`Miễn phí ship cho đơn từ ${money(z.free_from)}.`);
    }
  }
  if (z.eta) parts.push(`Thời gian: ${z.eta}`);
  if (z.note) parts.push(z.note);
  return parts.join('\n');
}

function stats() {
  return { zones: cache.zones.length, has_terms: !!cache.terms };
}

module.exports = { refresh, promptBlock, findZone, quote, stats };
