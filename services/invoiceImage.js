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
  const height = 168 + 210 + tableH + 210 + 340 + (invoice.link ? 72 : 36);
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

  let y = 184;
  ctx.fillStyle = '#5c564e';
  ctx.font = '16px Noto';
  ctx.fillText('HOÁ ĐƠN', 32, y);
  y += 40;
  ctx.fillStyle = '#0f5a35';
  ctx.font = '40px NotoBold';
  ctx.fillText(String(invoice.code || ''), 32, y);
  y += 32;
  ctx.fillStyle = '#5c564e';
  ctx.font = '16px Noto';
  ctx.fillText(when(invoice.created_at), 32, y);
  y += 28;
  const who = [invoice.customer_name || 'Khách', invoice.customer_phone || ''].filter(Boolean).join(' · ');
  ctx.fillStyle = '#1c1712';
  ctx.font = '18px Noto';
  ctx.fillText(who, 32, y);
  y += 28;

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

module.exports = { render, FARM, WIDTH };
