/**
 * Phone-readable invoice PNG. QR is drawn from a local EMVCo payload
 * (services/emvco.js + the qrcode package). No external QR or image host.
 */
const fs = require('fs');
const path = require('path');
const { Readable, PassThrough } = require('stream');
const PImage = require('pureimage');
const QRCode = require('qrcode');
const emvco = require('./emvco');

const FONT_DIR = path.join(__dirname, '..', 'assets', 'fonts');
const WIDTH = 720;

const FARM = {
  title: 'HTX Nông Trại Dốc Mơ',
  brand: 'Dốc Mơ Farm',
  address: 'Ấp Phúc Nhạc, Xã Gia Kiệm, Đồng Nai',
  hotline: '0363411625',
  bank: 'VCB',
  account: emvco.ACCOUNT,
  accountName: emvco.ACCOUNT_NAME,
};

let fontsReady = null;

function loadFonts() {
  if (!fontsReady) {
    const regularPath = path.join(FONT_DIR, 'NotoSans-Regular.ttf');
    const boldPath = path.join(FONT_DIR, 'NotoSans-Bold.ttf');
    if (!fs.existsSync(regularPath) || !fs.existsSync(boldPath)) {
      return Promise.reject(new Error('Thiếu font hoá đơn'));
    }
    const regular = PImage.registerFont(regularPath, 'Noto');
    const bold = PImage.registerFont(boldPath, 'NotoBold');
    fontsReady = Promise.all([regular.load(), bold.load()]).catch(err => {
      fontsReady = null;
      throw err;
    });
  }
  return fontsReady;
}

function money(n) {
  const value = Math.round(Number(n) || 0);
  return `${value.toLocaleString('vi-VN')}đ`;
}

function when(iso) {
  const d = iso ? new Date(iso) : new Date();
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d);
}

function wrap(ctx, text, max) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  const pushLong = (word) => {
    let chunk = '';
    for (const ch of word) {
      const next = chunk + ch;
      if (ctx.measureText(next).width <= max) chunk = next;
      else {
        if (chunk) lines.push(chunk);
        chunk = ch;
      }
    }
    return chunk;
  };
  for (const word of words) {
    const next = cur ? `${cur} ${word}` : word;
    if (ctx.measureText(next).width <= max) {
      cur = next;
      continue;
    }
    if (cur) lines.push(cur);
    if (ctx.measureText(word).width <= max) cur = word;
    else cur = pushLong(word);
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}

function escHtml(value) {
  return String(value || '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function ellipsize(ctx, text, maxWidth) {
  const raw = String(text || '');
  if (maxWidth <= 0) return '…';
  if (ctx.measureText(raw).width <= maxWidth) return raw;
  const ell = '…';
  let out = '';
  for (const ch of raw) {
    if (ctx.measureText(out + ch + ell).width > maxWidth) break;
    out += ch;
  }
  return `${out || raw.slice(0, 1)}…`;
}

/**
 * One header row: name, then Mã KH, then Mã HĐ, then the date when it fits.
 * The name is the only field that may be shortened.
 */
function layoutHeader(ctx, invoice, width) {
  const name = String((invoice && invoice.customer_name) || 'Khách').trim() || 'Khách';
  const kh = String((invoice && invoice.customer_code) || '').trim();
  const hd = String((invoice && invoice.code) || '').trim();
  let date = when(invoice && invoice.created_at);
  const gap = 12;
  const left = 32;
  const inner = Math.max(0, (width || WIDTH) - 64);
  const measureFixed = (includeDate) => {
    ctx.font = '16px Noto';
    const khW = kh ? ctx.measureText(kh).width : 0;
    const hdW = hd ? ctx.measureText(hd).width : 0;
    const dateW = includeDate && date ? ctx.measureText(date).width : 0;
    const pieces = [khW, hdW, dateW].filter(w => w > 0);
    const used = pieces.reduce((sum, w) => sum + w, 0) + gap * Math.max(0, pieces.length);
    return { khW, hdW, dateW, used };
  };
  let fixed = measureFixed(true);
  if (inner - fixed.used < 72 && date) {
    date = '';
    fixed = measureFixed(false);
  }
  ctx.font = '22px NotoBold';
  const shown = ellipsize(ctx, name, Math.max(24, inner - fixed.used));
  const nameW = ctx.measureText(shown).width;
  const y = 0;
  let x = left;
  const slots = {
    y,
    name: { text: shown, x, y, font: '22px NotoBold', fill: '#1c1712' },
  };
  x += nameW + gap;
  if (kh) {
    slots.kh = { text: kh, x, y, font: '16px Noto', fill: '#0f5a35' };
    x += fixed.khW + gap;
  }
  if (hd) {
    slots.hd = { text: hd, x, y, font: '16px Noto', fill: '#0f5a35' };
    x += fixed.hdW + gap;
  }
  if (date) slots.date = { text: date, x, y, font: '16px Noto', fill: '#5c564e' };
  return slots;
}

/** The same row as one element, for the public page and the render test. */
function headerHtml(invoice) {
  const name = escHtml((invoice && invoice.customer_name) || 'Khách');
  const kh = escHtml(invoice && invoice.customer_code);
  const hd = escHtml(invoice && invoice.code);
  const bits = [
    `<span class="id-name">${name}</span>`,
    kh ? `<span class="id-code" title="Mã KH">${kh}</span>` : '',
    hd ? `<span class="id-code" title="Mã HĐ">${hd}</span>` : '',
  ].filter(Boolean);
  return `<div class="id-row">${bits.join('')}</div>`;
}

function moneyText(n) {
  return `${Math.round(Number(n) || 0).toLocaleString('vi-VN')}đ`;
}

/** Every line under the one-row header. The header itself stays name + Mã KH + Mã HĐ. */
function linesHtml(invoice) {
  const items = Array.isArray(invoice && invoice.items) ? invoice.items : [];
  const rows = items.map(item => {
    const name = escHtml(item.name || item.product_name || 'Sản phẩm');
    const qty = escHtml(item.quantity ?? '');
    const amount = item.amount != null ? item.amount : Number(item.price) * Number(item.quantity);
    return `<li><span>${name} × ${qty}</span><span>${moneyText(amount)}</span></li>`;
  }).join('');
  const total = Math.round(Number(invoice && invoice.total) || 0);
  return `<ul class="inv-lines">${rows}</ul><p class="inv-total">Tổng ${moneyText(total)}</p>`;
}

function pageHtml(row, imgSrc) {
  const total = Math.round(Number(row && row.total) || 0).toLocaleString('vi-VN');
  const phone = row && row.customer_phone ? escHtml(row.customer_phone) : '';
  const stamp = row && row.created_at ? new Intl.DateTimeFormat('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(new Date(row.created_at)) : '';
  const code = escHtml(row && row.code);
  const meta = [phone, stamp, `Tổng ${total}đ`, 'VCB 1058437590', `nội dung CK: ${code}`].filter(Boolean).join(' · ');
  const address = row && row.delivery_address ? escHtml(row.delivery_address) : '';
  return `<!doctype html>
<html lang="vi"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${code}</title>
<style>
  body { margin: 0; background: #f6f3ee; color: #1c1712; font: 17px/1.45 "Be Vietnam Pro", sans-serif; }
  main { max-width: 720px; margin: 0 auto; padding: 16px; }
  .id-row { display: flex; flex-wrap: nowrap; align-items: baseline; gap: 8px; min-width: 0; }
  .id-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 22px; font-weight: 700; }
  .id-code { flex: 0 0 auto; white-space: nowrap; font-size: 15px; font-weight: 600; color: #0f5a35; }
  .meta { margin: 6px 0 10px; color: #5c564e; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .addr-line { margin: 0 0 10px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .inv-lines { list-style: none; margin: 0 0 8px; padding: 0; }
  .inv-lines li { display: flex; justify-content: space-between; gap: 12px; padding: 6px 0; border-bottom: 1px solid #e7e1d8; }
  .inv-total { margin: 8px 0 12px; font-size: 20px; font-weight: 700; }
  img { width: 100%; height: auto; background: #fff; border-radius: 12px; }
</style></head><body><main>
${headerHtml(row)}
<p class="meta">${meta}</p>
${address ? `<p class="addr-line">${address}</p>` : ''}
${linesHtml(row)}
<img src="${escHtml(imgSrc || '')}" alt="Hoá đơn ${code}">
</main></body></html>`;
}

function drawHeader(ctx, slots, y) {
  for (const key of ['name', 'kh', 'hd', 'date']) {
    const slot = slots[key];
    if (!slot) continue;
    ctx.fillStyle = slot.fill;
    ctx.font = slot.font;
    ctx.fillText(slot.text, slot.x, y);
  }
}

function pngBuffer(bitmap) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const stream = new PassThrough();
    stream.on('data', chunk => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
    PImage.encodePNGToStream(bitmap, stream).catch(reject);
  });
}

async function qrBitmap(payload) {
  const png = await QRCode.toBuffer(payload, {
    type: 'png',
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 280,
    color: { dark: '#102117', light: '#ffffff' },
  });
  return PImage.decodePNGFromStream(Readable.from(png));
}

/**
 * @param {object} invoice code, created_at, customer_name, customer_phone,
 *   items[{name,quantity,price,amount}], total, amount_paid, link
 */
async function render(invoice) {
  await loadFonts();
  const items = Array.isArray(invoice.items) ? invoice.items : [];
  const total = Math.round(Number(invoice.total) || 0);
  const paid = Math.round(Number(invoice.amount_paid) || 0);
  const due = Math.max(0, total - paid);
  const payload = emvco.buildPayload({ amount: due, addInfo: invoice.code });
  const measure = PImage.make(WIDTH, 10).getContext('2d');
  measure.font = '18px Noto';
  const nameLines = items.map(item => wrap(measure, item.name || item.product_name || 'Sản phẩm', 300));
  const rowHeights = nameLines.map(lines => Math.max(32, lines.length * 22 + 10));
  const tableH = 36 + rowHeights.reduce((s, h) => s + h, 0);
  const addressLine = invoice.delivery_address ? String(invoice.delivery_address) : '';
  const height = 168 + 96 + tableH + 210 + 340 + (invoice.link ? 72 : 36) + (addressLine ? 28 : 0);
  const img = PImage.make(WIDTH, height);
  const ctx = img.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, WIDTH, height);

  ctx.fillStyle = '#0f5a35';
  ctx.fillRect(0, 0, WIDTH, 148);
  ctx.fillStyle = '#ffffff';
  ctx.font = '28px NotoBold';
  ctx.fillText(FARM.title, 32, 52);
  ctx.font = '18px Noto';
  ctx.fillText(FARM.brand, 32, 80);
  ctx.fillText(FARM.address, 32, 106);
  ctx.fillText(`Hotline ${FARM.hotline}`, 32, 130);

  let y = 188;
  const slots = layoutHeader(ctx, invoice, WIDTH);
  drawHeader(ctx, slots, y);
  y += 30;
  const metaBits = [invoice.customer_phone || '', money(total)];
  if (paid > 0) metaBits.push(`Đã thu ${money(paid)}`, `Còn ${money(due)}`);
  if (!slots.date && when(invoice.created_at)) metaBits.push(when(invoice.created_at));
  ctx.fillStyle = '#5c564e';
  ctx.font = '16px Noto';
  ctx.fillText(ellipsize(ctx, metaBits.filter(Boolean).join(' · '), WIDTH - 64), 32, y);
  y += 28;
  if (addressLine) {
    ctx.fillStyle = '#1c1712';
    ctx.font = '16px Noto';
    ctx.fillText(ellipsize(ctx, addressLine, WIDTH - 64), 32, y);
    y += 24;
  }

  ctx.fillStyle = '#e7efe9';
  ctx.fillRect(24, y, WIDTH - 48, 32);
  ctx.fillStyle = '#0f5a35';
  ctx.font = '15px NotoBold';
  ctx.fillText('Sản phẩm', 32, y + 21);
  ctx.fillText('SL', 360, y + 21);
  ctx.fillText('Giá', 450, y + 21);
  ctx.fillText('Tiền', 580, y + 21);
  y += 32;

  ctx.font = '16px Noto';
  items.forEach((item, index) => {
    const lines = nameLines[index];
    const h = rowHeights[index];
    if (index % 2 === 1) {
      ctx.fillStyle = '#f7f5f1';
      ctx.fillRect(24, y, WIDTH - 48, h);
    }
    ctx.fillStyle = '#1c1712';
    lines.forEach((line, i) => ctx.fillText(line, 32, y + 22 + i * 22));
    const mid = y + Math.max(22, Math.round(h / 2));
    ctx.fillText(String(item.quantity ?? ''), 360, mid);
    ctx.fillText(money(item.price), 430, mid);
    ctx.fillText(money(item.amount != null ? item.amount : Number(item.price) * Number(item.quantity)), 560, mid);
    y += h;
  });

  y += 16;
  ctx.fillStyle = '#0f5a35';
  ctx.font = '22px NotoBold';
  ctx.fillText(`Tổng ${money(total)}`, 32, y + 24);
  if (paid > 0) {
    ctx.font = '16px Noto';
    ctx.fillStyle = '#5c564e';
    ctx.fillText(`Đã thu ${money(paid)} · Còn ${money(due)}`, 32, y + 50);
    y += 28;
  }
  y += 48;

  const boxTop = y;
  ctx.fillStyle = '#f6f3ee';
  ctx.fillRect(24, boxTop, WIDTH - 48, 132);
  ctx.fillStyle = '#1c1712';
  ctx.font = '16px Noto';
  ctx.fillText('Chuyển khoản', 40, boxTop + 28);
  ctx.font = '22px NotoBold';
  ctx.fillText(`${FARM.bank} ${FARM.account}`, 40, boxTop + 58);
  ctx.font = '16px Noto';
  ctx.fillText(FARM.accountName, 40, boxTop + 84);
  ctx.fillText(`nội dung CK: ${invoice.code}`, 40, boxTop + 110);
  y = boxTop + 156;

  const qr = await qrBitmap(payload);
  const qx = Math.round((WIDTH - 280) / 2);
  ctx.drawImage(qr, qx, y, 280, 280);
  y += 300;
  if (invoice.link) {
    ctx.fillStyle = '#5c564e';
    ctx.font = '14px Noto';
    const linkLines = wrap(ctx, invoice.link, WIDTH - 64);
    linkLines.slice(0, 2).forEach(line => {
      ctx.fillText(line, 32, y);
      y += 20;
    });
  }
  return pngBuffer(img);
}

module.exports = { render, headerHtml, linesHtml, pageHtml, layoutHeader, FARM, WIDTH };
