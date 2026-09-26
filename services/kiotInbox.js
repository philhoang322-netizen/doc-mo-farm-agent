/**
 * Manager-only KiotViet sale from one HITL draft.
 *
 * Nothing is created until confirm === true. The chatbot path is untouched.
 * A successful create prefills draft_reply and leaves approval_status as it
 * was (PENDING_REVIEW unless a person already moved it). It never sends.
 */
const drafts = require('./drafts');
const audit = require('./audit');
const kiotviet = require('./kiotviet');
const stockGate = require('./stockGate');
const shipping = require('./shipping');
const catalog = require('./catalog');
const db = require('./database');
const quickEntry = require('./quickEntry');
const channelNames = require('./channelNames');
const customerLink = require('./customerLink');
const invoices = require('./invoices');

const BANK_BLOCK = 'HTX Nong Trai Doc Mo\nVCB 1058 43 7590';

const chains = new Map();
const remembered = new Map();

function queue(id, fn) {
  const prev = chains.get(id) || Promise.resolve();
  const next = prev.then(fn, fn);
  chains.set(id, next.then(() => {}, () => {}));
  return next;
}

function norm(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase();
}

function formatVnd(n) {
  const value = Number(n);
  if (!Number.isFinite(value)) return '0đ';
  return `${Math.round(value).toLocaleString('vi-VN')}đ`;
}

function paymentDraft({ code, total, link, paid }) {
  const lines = [`Dạ em đã tạo hoá đơn ${code} cho mình, tổng ${formatVnd(total)} ạ.`];
  if (!paid) {
    lines.push('', 'Mình chuyển khoản giúp em:', BANK_BLOCK, `nội dung CK: ${code}`);
  }
  if (link) lines.push('', `Hoá đơn: ${link}`);
  return lines.join('\n');
}

function orderAck({ code, total }) {
  return `Dạ em đã tạo đơn đặt hàng ${code}, tổng ${formatVnd(total)} ạ. Em xuất hoá đơn và gửi mã QR khi mình xác nhận giúp em.`;
}

function cleanPhone(v) {
  const s = String(v || '').replace(/\0/g, '').trim();
  if (!s) return '';
  if (s.length > 40) return '';
  const digits = s.replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 15) return '';
  return s;
}

function money(v) {
  if (v == null || v === '') return 0;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 1e12) return null;
  return Math.round(n);
}

function quantityOf(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > 100000) return null;
  return Math.round(n * 1000) / 1000;
}

function quantityNear(text, label) {
  const raw = String(text || '');
  const needle = String(label || '').toLowerCase();
  const idx = needle ? raw.toLowerCase().indexOf(needle) : -1;
  const from = idx >= 0 ? Math.max(0, idx - 24) : 0;
  const to = idx >= 0 ? Math.min(raw.length, idx + needle.length + 16) : Math.min(raw.length, 120);
  const slice = raw.slice(from, to);
  const re = /(\d+(?:[.,]\d+)?)\s*(kg|g|chai|gói|goi|túi|tui|lon|hộp|hop)?/gi;
  let best = null;
  let m;
  while ((m = re.exec(slice))) {
    const n = Number(String(m[1]).replace(',', '.'));
    if (!Number.isFinite(n) || n <= 0 || n > 100000) continue;
    const at = from + m.index;
    const dist = idx >= 0 ? Math.abs(at - idx) : 0;
    if (!best || dist < best.dist) best = { n, dist };
  }
  return best ? Math.round(best.n * 1000) / 1000 : 1;
}

function suggestLines(text) {
  const blob = String(text || '');
  const lines = [];
  const seen = new Set();
  const push = (line) => {
    const key = `${line.sku || ''}|${norm(line.product_name)}`;
    if (seen.has(key)) return;
    seen.add(key);
    lines.push(line);
  };
  for (const p of catalog.rows()) {
    const name = String(p.name_vi || '').trim();
    if (name.length < 3) continue;
    if (!blob.toLowerCase().includes(name.toLowerCase())) continue;
    push({
      product_name: name,
      sku: p.sku || null,
      quantity: quantityNear(blob, name),
    });
  }
  if (norm(blob).replace(/[^a-z0-9]/g, '').includes('heotrang')) {
    const alias = kiotviet.aliasFor(blob);
    const name = (alias && alias.name) || 'Heo trắng';
    if (!lines.some(line => norm(line.product_name).replace(/[^a-z0-9]/g, '').includes('heotrang'))) {
      push({
        product_name: name,
        sku: (alias && alias.sku) || null,
        quantity: quantityNear(blob, 'heo trắng') || quantityNear(blob, 'heo trang'),
      });
    }
  }
  return lines.slice(0, 8);
}

function addressFrom(draft) {
  const f = (draft && draft.review_form) || {};
  if (f.address_line) return String(f.address_line).trim();
  return [f.address_detail, f.ward_name, f.district_name, f.province_name]
    .map(part => String(part || '').trim())
    .filter(Boolean)
    .join(', ');
}

function existingSale(draft) {
  if (!draft) return null;
  const f = draft.review_form || {};
  if (f.kiot_code) {
    return {
      code: f.kiot_code,
      total: f.kiot_total != null ? Number(f.kiot_total) : null,
      kind: f.kiot_kind || null,
    };
  }
  const rememberedSale = remembered.get(draft.id);
  if (rememberedSale) return rememberedSale;
  const code = String(draft.invoice_code || '').trim();
  if (/^(HD|DH)/i.test(code)) {
    return { code, total: null, kind: /^DH/i.test(code) ? 'order' : 'invoice' };
  }
  return null;
}

function shippingFeeFor(address) {
  const place = String(address || '').trim();
  if (!place) return null;
  const zone = shipping.findZone(place);
  if (!zone) return null;
  const folded = norm(place);
  const keys = norm(zone.keywords || '').split(',').map(s => s.trim()).filter(Boolean);
  const named = norm(zone.name || '');
  const hit = keys.some(k => k && (folded.includes(k) || k.includes(folded)))
    || (named && folded.includes(named));
  if (!hit) return null;
  const fee = Number(zone.fee);
  return Number.isFinite(fee) && fee >= 0 ? Math.round(fee) : null;
}

async function customerFacts(draft) {
  let name = draft.customer_name || '';
  let phone = draft.customer_phone || '';
  let address = addressFrom(draft);
  if (db.DB_ENABLED && draft.customer_user_id) {
    try {
      const customer = await db.getCustomerByExternalId(draft.customer_user_id);
      if (customer) {
        name = name || customer.display_name || customer.full_name || '';
        phone = phone || customer.phone || '';
        address = address || customer.full_address || '';
      }
    } catch (_) { /* inbox still opens from the draft itself */ }
  }
  return { name, phone, address };
}

async function prefill(id) {
  const draft = await drafts.getDraft(id);
  if (!draft) return { status: 404, body: { error: 'Không thấy bản nháp' } };
  const facts = await customerFacts(draft);
  const text = [draft.customer_query, draft.customer_intent, draft.draft_reply].filter(Boolean).join('\n');
  const ship = shippingFeeFor(facts.address);
  const suggested = suggestLines(text);
  let names = [];
  try {
    names = await channelNames.forDraft({ ...draft, customer_phone: facts.phone || draft.customer_phone });
  } catch (_) { names = []; }
  const kiotLine = names.find(item => item && item.source === 'kiot');
  const chosen = channelNames.formName({
    kiotName: kiotLine && kiotLine.name,
    channelNames: names,
    draftName: facts.name || '',
  });
  return {
    status: 200,
    body: {
      customer_name: chosen.name,
      name_hint: chosen.hint,
      kiot_customer_id: kiotLine && kiotLine.id ? kiotLine.id : null,
      kiot_customer_code: kiotLine && kiotLine.code ? kiotLine.code : '',
      phone: facts.phone || '',
      address: facts.address || '',
      shipping_fee: ship,
      lines: suggested,
      quick_text: quickEntry.prefillText({
        customer_query: draft.customer_query,
        customer_intent: draft.customer_intent,
        suggested,
      }),
      existing: existingSale(draft),
      channel: draft.channel,
    },
  };
}

function aliasesForMatch() {
  const alias = kiotviet.aliasFor('heo trắng');
  if (!alias) return [];
  return [{ key: 'heotrang', sku: alias.sku || null }];
}

function stockLevel(available, quantity) {
  if (available == null || !Number.isFinite(Number(available))) return 'unknown';
  return stockGate.classifyLine({
    available: Number(available),
    requested: quantity,
    threshold: stockGate.threshold(),
  });
}

function presentLine(line, stockMap) {
  const product = line.product;
  const code = product && product.code ? String(product.code).toUpperCase() : '';
  const hand = code ? stockMap.get(code) : null;
  const available = hand && hand.ok ? Number(hand.available) : (product ? product.available : null);
  const known = available != null && Number.isFinite(Number(available));
  return {
    status: line.status,
    phrase: line.phrase,
    quantity: line.quantity,
    unit: line.unit || (product && product.unit) || null,
    warning: line.warning || null,
    sku: product ? product.code : null,
    name: product ? product.name : null,
    price: product ? product.price : null,
    line_total: product && product.price != null ? Math.round(Number(line.quantity) * Number(product.price)) : null,
    stock: product ? {
      level: known ? stockLevel(available, line.quantity) : 'unknown',
      available: known ? Number(available) : null,
      onHand: hand && hand.ok ? hand.onHand : null,
      reserved: hand && hand.ok ? hand.reserved : null,
    } : null,
    candidates: (line.candidates || []).map(c => ({
      sku: c.code,
      name: c.name,
      price: c.price,
      unit: c.unit,
      available: c.available,
    })),
  };
}

async function liveStockMap(codes) {
  const map = new Map();
  const branch = kiotviet.saleBranchId();
  for (const code of codes) {
    try {
      const hand = await kiotviet.getOnHand({ sku: code, branchId: branch });
      if (hand && hand.ok) map.set(String(code).toUpperCase(), hand);
    } catch (_) { /* leave this code unknown; the line stays editable */ }
  }
  return map;
}

/**
 * Parse a quick-entry string and match the cached KiotViet catalog.
 * Does not create a document.
 */
async function quickFill(text) {
  const raw = String(text || '').replace(/\0/g, '').trim();
  if (!raw) return { status: 400, body: { error: 'Nhập sản phẩm và số lượng' } };
  if (raw.length > 2000) return { status: 400, body: { error: 'Dòng nhập quá dài' } };
  if (!kiotviet.enabled()) return { status: 503, body: { error: 'KiotViet chưa cấu hình' } };
  let products;
  try {
    products = await kiotviet.listProductsForMatch();
  } catch (e) {
    return { status: 502, body: { error: e.message || 'Không tải được danh mục KiotViet' } };
  }
  const aliases = aliasesForMatch();
  let matched = quickEntry.matchQuickEntry(raw, products, { aliases });
  const codes = [];
  for (const line of matched.lines) {
    if (line.product && line.product.code) codes.push(line.product.code);
    for (const candidate of (line.candidates || []).slice(0, 5)) {
      if (candidate.code) codes.push(candidate.code);
    }
  }
  const unique = [...new Set(codes)].slice(0, 20);
  const stockMap = await liveStockMap(unique);
  if (stockMap.size) {
    products = products.map(product => {
      const hand = stockMap.get(String(product.code || '').toUpperCase());
      if (!hand) return product;
      return { ...product, available: hand.available };
    });
    matched = quickEntry.matchQuickEntry(raw, products, { aliases });
  }
  return {
    status: 200,
    body: {
      created: false,
      lines: matched.lines.map(line => presentLine(line, stockMap)),
    },
  };
}

function parseLines(raw, confirmSku) {
  if (!Array.isArray(raw) || !raw.length) return { error: 'Cần ít nhất một dòng hàng' };
  if (raw.length > 30) return { error: 'Tối đa 30 dòng hàng' };
  const lines = [];
  for (const row of raw) {
    if (!row || typeof row !== 'object') return { error: 'Dòng hàng không hợp lệ' };
    const product_name = String(row.product_name || row.name || '').replace(/\0/g, '').trim().slice(0, 200);
    const sku = String(row.sku || '').replace(/\0/g, '').trim().slice(0, 80);
    if (!product_name && !sku) return { error: 'Mỗi dòng cần tên hoặc mã sản phẩm' };
    if (confirmSku && !sku) return { error: 'Mỗi dòng cần mã KiotViet. Chọn sản phẩm, đừng để hệ thống đoán.' };
    const quantity = quantityOf(row.quantity);
    if (quantity == null) return { error: 'Số lượng không hợp lệ' };
    lines.push({ product_name, sku: sku || null, quantity });
  }
  return { lines };
}

function lineTotal(qty, price) {
  return Math.round(Number(qty) * Number(price));
}

async function quoteLines(lines) {
  const quoted = [];
  for (const line of lines) {
    const alias = kiotviet.aliasFor(line.product_name);
    const sku = line.sku || (alias && alias.sku) || '';
    let product = null;
    try {
      if (sku) product = await kiotviet.findProduct({ sku });
    } catch (e) {
      return { error: e.message || 'Không tra được sản phẩm' };
    }
    if (!product) {
      quoted.push({
        ...line,
        name: line.product_name || line.sku,
        price: null,
        line_total: null,
        missing: true,
      });
      continue;
    }
    const price = Number(product.basePrice != null ? product.basePrice : product.price) || 0;
    quoted.push({
      product_name: line.product_name || product.fullName || product.name,
      sku: product.code || line.sku || null,
      name: product.fullName || product.name || line.product_name,
      quantity: line.quantity,
      price,
      line_total: lineTotal(line.quantity, price),
      missing: false,
      productId: product.id,
    });
  }
  return { quoted };
}

function totalsOf(quoted, discount, shippingFee) {
  const subtotal = quoted.reduce((sum, line) => sum + (Number(line.line_total) || 0), 0);
  const total = Math.max(0, subtotal - discount + shippingFee);
  return { subtotal, total };
}

async function stockOf(lines) {
  const items = lines.map(line => ({
    sku: line.sku,
    product_name: line.product_name || line.name,
    quantity: line.quantity,
  }));
  return stockGate.assessItems(items, { branchId: kiotviet.saleBranchId() });
}

function stockBySku(assessment) {
  const map = new Map();
  for (const line of assessment.lines || []) {
    map.set(`${line.sku || ''}|${line.product_name || line.name || ''}`, line);
  }
  return map;
}

function attachStock(quoted, assessment) {
  const rows = assessment.lines || [];
  return quoted.map((line, i) => {
    const stock = rows[i] || null;
    return {
      ...line,
      stock: stock ? {
        level: stock.level,
        available: stock.available,
        onHand: stock.onHand,
        reserved: stock.reserved,
        reason: stock.reason || null,
      } : null,
    };
  });
}

function blockedReason(assessment, quoted) {
  if (quoted.some(line => line.missing)) {
    const names = quoted.filter(line => line.missing).map(line => line.product_name || line.sku);
    return `Chưa có trong KiotViet: ${names.join(', ')}`;
  }
  if (!assessment || assessment.decision === 'skipped') return 'KiotViet chưa cấu hình';
  if (assessment.decision === 'blocked') return assessment.summary || 'Không đủ tồn kho';
  return null;
}

async function prepareOrCreate(id, body, actorName) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { status: 400, body: { error: 'Cần một JSON object' } };
  }
  const confirm = body.confirm === true;
  const kind = body.document === 'order' ? 'order' : 'invoice';
  const parsed = parseLines(body.lines, confirm);
  if (parsed.error) return { status: 400, body: { error: parsed.error } };
  const discount = money(body.discount);
  const shippingFee = money(body.shipping_fee);
  if (discount == null || shippingFee == null) {
    return { status: 400, body: { error: 'Giảm giá hoặc phí ship không hợp lệ' } };
  }
  const phone = cleanPhone(body.phone);
  const customerName = String(body.customer_name || '').replace(/\0/g, '').trim().slice(0, 200);
  const address = String(body.address || '').replace(/\0/g, '').trim().slice(0, 300);
  const note = String(body.note || '').replace(/\0/g, '').trim().slice(0, 500);

  if (!kiotviet.enabled()) {
    return { status: 503, body: { error: 'KiotViet chưa cấu hình' } };
  }

  const priced = await quoteLines(parsed.lines);
  if (priced.error) return { status: 502, body: { error: priced.error } };
  const assessment = await stockOf(parsed.lines);
  const lines = attachStock(priced.quoted, assessment);
  const { subtotal, total } = totalsOf(lines, discount, shippingFee);
  const block = blockedReason(assessment, lines);
  const low = assessment && assessment.decision === 'low';
  const preview = {
    ok: !block,
    created: false,
    document: kind,
    branchId: kiotviet.saleBranchId(),
    customer_name: customerName,
    phone,
    address,
    note,
    discount,
    shipping_fee: shippingFee,
    lines,
    subtotal,
    total,
    stock: {
      decision: assessment.decision,
      summary: assessment.summary,
      threshold: assessment.threshold,
    },
    can_confirm: !block && !!phone,
    phone_required: !phone,
  };
  if (!confirm) {
    if (block) preview.error = block;
    else if (!phone) preview.error = 'Cần số điện thoại để tạo khách trên KiotViet';
    return { status: 200, body: preview };
  }
  if (!phone) return { status: 400, body: { error: 'Cần số điện thoại để tạo khách trên KiotViet', ...preview } };
  if (block) return { status: 409, body: { error: block, ...preview, ok: false } };

  return queue(id, async () => {
    const draft = await drafts.getDraft(id);
    if (!draft) return { status: 404, body: { error: 'Không thấy bản nháp' } };
    const existing = existingSale(draft);
    if (existing && body.acknowledge_existing !== true) {
      return {
        status: 409,
        body: {
          error: `Nháp này đã có chứng từ ${existing.code}. Không tạo thêm.`,
          existing,
          created: false,
        },
      };
    }
    if (body.expected_total != null && body.expected_total !== '') {
      const expected = Number(body.expected_total);
      if (!Number.isFinite(expected) || Math.abs(expected - total) > 1) {
        return {
          status: 409,
          body: { error: 'Tổng tiền vừa đổi. Xem lại rồi xác nhận lại.', ...preview, ok: false },
        };
      }
    }

    const description = [
      `Inbox ${draft.id}`,
      address ? `Giao: ${address}` : null,
      note || null,
    ].filter(Boolean).join(' | ').slice(0, 500);
    const invoiceKind = kind === 'invoice';
    const paid = invoiceKind && body.payment_status === 'da_tt';
    const paymentMethod = body.payment_method === 'cash' ? 'cash' : 'transfer';

    let customerComment = '';
    try {
      customerComment = channelNames.kiotComment(await channelNames.forDraft(draft));
    } catch (_) { customerComment = ''; }
    const created = await kiotviet.createSaleDocument({
      documentType: kind,
      customerName: customerName || draft.customer_name,
      customerComment,
      phone,
      address,
      note,
      discount,
      shippingFee,
      lines: lines.map(line => ({
        sku: line.sku,
        product_name: line.product_name,
        quantity: line.quantity,
      })),
      description,
      customerId: body.kiot_customer_id,
      customerCode: body.kiot_customer_code,
      paid: paid && kind === 'invoice',
      paymentMethod,
    });
    if (!created || !created.ok) {
      return {
        status: 502,
        body: { error: (created && created.error) || 'KiotViet không tạo được chứng từ', created: false },
      };
    }

    remembered.set(draft.id, {
      code: created.code,
      total: created.total,
      kind: created.documentType || kind,
    });

    const saleItems = lines.map(line => ({
      name: line.name || line.product_name,
      sku: line.sku,
      quantity: line.quantity,
      price: line.price,
      amount: line.line_total,
    }));
    let recorded = null;
    try {
      recorded = await invoices.recordSale({
        kiotId: created.id,
        code: created.code,
        draftId: draft.id,
        documentType: created.documentType || kind,
        customerCode: created.customerCode || body.kiot_customer_code,
        customerName: created.customerName || customerName || draft.customer_name,
        customerPhone: phone,
        channel: draft.channel,
        items: saleItems,
        total: created.total,
        deliveryAddress: address,
        paymentStatus: paid ? 'da_tt' : 'chua_tt',
        paymentMethod: paid ? paymentMethod : null,
        paidAt: paid ? new Date().toISOString() : null,
        paidBy: paid ? audit.managerActor(actorName) : null,
        kiotPaymentIncluded: paid,
      }, audit.managerActor(actorName));
      if (recorded && (created.documentType || kind) === 'invoice') {
        recorded = await invoices.replaceWithKiotRead(recorded.code) || recorded;
      }
    } catch (err) {
      console.error('Invoice record failed:', err.message);
    }

    const isInvoice = (created.documentType || kind) === 'invoice';
    const payStatus = recorded && (recorded.payment_status === 'da_tt' || recorded.payment_status === 'mot_phan')
      ? recorded.payment_status
      : 'chua_tt';
    const link = isInvoice ? invoices.pageUrl(created.code) : '';
    const reply = isInvoice
      ? paymentDraft({ code: created.code, total: created.total, link, paid: payStatus === 'da_tt' })
      : orderAck({ code: created.code, total: created.total });
    const summary = `${created.code} · ${formatVnd(created.total)}`;
    const nextForm = {
      ...(draft.review_form || {}),
      kiot_code: created.code,
      kiot_total: String((recorded && recorded.total) || created.total),
      kiot_kind: created.documentType || kind,
      payment_status: payStatus,
      payment_method: payStatus === 'chua_tt' ? null : (recorded && recorded.payment_method) || null,
      amount_paid: recorded ? recorded.amount_paid : 0,
      paid_at: payStatus === 'chua_tt' ? null : (recorded && recorded.paid_at) || null,
      paid_by: payStatus === 'chua_tt' ? null : (recorded && recorded.paid_by) || null,
    };
    const patch = {
      invoice_code: created.code,
      kiot_summary: summary,
      review_form: nextForm,
      actor_name: actorName || '',
    };
    if (draft.approval_status !== 'SENT') patch.draft_reply = reply;
    if (isInvoice) {
      const picture = invoices.imageUrl(created.code);
      if (picture) patch.qr_image_url = picture;
    }
    const kiotCode = created.customerCode || body.kiot_customer_code || '';
    const kiotId = created.customerId || body.kiot_customer_id || '';
    const samePhone = db.normalizePhone(draft.customer_phone) && db.normalizePhone(draft.customer_phone) === db.normalizePhone(phone);
    if (!draft.customer_phone || (kiotCode && phone && !samePhone)) patch.customer_phone = phone;
    if (!draft.customer_name && customerName) patch.customer_name = customerName;
    if (!draft.customer_code && kiotCode) patch.customer_code = String(kiotCode).slice(0, 40);
    try {
      await channelNames.rememberKiot(draft.customer_user_id, {
        id: kiotId,
        code: kiotCode,
        name: created.customerName || customerName || draft.customer_name,
        phone,
      });
    } catch (err) {
      console.error('Kiot customer code save skipped:', err.message);
    }
    try {
      await customerLink.note({
        phone,
        name: customerName || draft.customer_name,
        channel: draft.channel,
        userId: draft.customer_user_id,
        kiotCustomerId: created.customerId || kiotId || null,
      });
    } catch (err) {
      console.error('Customer link skipped:', err.message);
    }

    let saved = null;
    try {
      const updated = await drafts.updateDraft(draft.id, patch, { actorName });
      saved = updated && updated.draft;
      if (saved) {
        saved = await drafts.setInboxStatus(saved.id, 'bought', {
          actor: audit.managerActor(actorName),
          auto: true,
          orderCode: created.code,
        }) || saved;
      }
    } catch (e) {
      return {
        status: 200,
        body: {
          ok: true,
          created: true,
          saved: false,
          code: created.code,
          total: created.total,
          document: created.documentType || kind,
          error: 'Đã tạo trên KiotViet nhưng chưa ghi được vào nháp. Đừng tạo lại — kiểm tra mã ' + created.code,
        },
      };
    }

    try {
      await audit.record({
        actor: audit.managerActor(actorName),
        action: 'kiotviet.created',
        entity_type: 'draft',
        entity_id: draft.id,
        before: audit.draftSnapshot(draft),
        after: {
          ...(saved ? audit.draftSnapshot(saved) : {}),
          kiot_code: created.code,
          total: created.total,
          document: created.documentType || kind,
        },
        meta: audit.draftMeta(draft, {
          kiot_code: created.code,
          order_number: created.code,
          document: created.documentType || kind,
          total: created.total,
          low_stock: !!low,
        }),
      });
    } catch (e) {
      console.error('KiotViet audit failed:', e.message);
    }

    return {
      status: 200,
      body: {
        ok: true,
        created: true,
        saved: true,
        code: created.code,
        total: created.total,
        document: created.documentType || kind,
        customer_code: kiotCode || null,
        summary,
        draft: saved,
        page_url: isInvoice ? link : null,
        image_url: isInvoice ? invoices.imageUrl(created.code) : null,
        low_stock: !!low,
        stock_summary: low ? assessment.summary : null,
      },
    };
  });
}

async function issueInvoice(id, actorName, body) {
  return queue(id, async () => {
    const draft = await drafts.getDraft(id);
    if (!draft) return { status: 404, body: { error: 'Không thấy bản nháp' } };
    const existing = existingSale(draft);
    if (!existing) return { status: 400, body: { error: 'Nháp chưa có đơn đặt hàng' } };
    const kind = (draft.review_form && draft.review_form.kiot_kind) || (/^DH/i.test(existing.code) ? 'order' : 'invoice');
    if (kind !== 'order') {
      return { status: 409, body: { error: 'Chứng từ này đã là hoá đơn', code: existing.code } };
    }
    const row = await invoices.getByCode(existing.code);
    const request = body || {};
    const paid = request.payment_status === 'da_tt';
    const paymentMethod = request.payment_method === 'cash' ? 'cash' : 'transfer';
    const issued = await kiotviet.issueInvoiceFromOrder({
      orderId: (row && (row.order_kiot_id || row.kiot_id)) || null,
      orderCode: existing.code,
      paid,
      paymentMethod,
    });
    if (!issued || !issued.ok) {
      return { status: 502, body: { error: (issued && issued.error) || 'Không xuất được hoá đơn' } };
    }
    let savedRow = null;
    try {
      savedRow = await invoices.markIssued(existing.code, {
        id: issued.id,
        code: issued.code,
        total: issued.total,
        draftId: draft.id,
        customerName: (row && row.customer_name) || draft.customer_name,
        customerPhone: (row && row.customer_phone) || draft.customer_phone,
        customerCode: issued.customerCode || (row && row.customer_code) || draft.customer_code,
        channel: draft.channel,
        items: row && row.items,
        paid: issued.paid === true,
        paymentMethod: issued.paymentMethod,
        paidBy: (row && row.paid_by) || audit.managerActor(actorName),
      }, audit.managerActor(actorName));
      if (savedRow) savedRow = await invoices.replaceWithKiotRead(savedRow.code) || savedRow;
    } catch (err) {
      console.error('markIssued failed:', err.message);
      return {
        status: 200,
        body: {
          ok: true,
          created: true,
          saved: false,
          code: issued.code,
          error: 'Đã xuất hoá đơn trên KiotViet nhưng chưa ghi được. Đừng xuất lại — kiểm tra mã ' + issued.code,
        },
      };
    }
    const link = invoices.pageUrl(issued.code);
    const reply = paymentDraft({ code: issued.code, total: savedRow.total, link, paid: savedRow.payment_status === 'da_tt' });
    const nextForm = {
      ...(draft.review_form || {}),
      kiot_code: issued.code,
      kiot_total: String(savedRow.total),
      kiot_kind: 'invoice',
      payment_status: savedRow.payment_status === 'da_tt' || savedRow.payment_status === 'mot_phan'
        ? savedRow.payment_status
        : 'chua_tt',
      payment_method: savedRow.payment_status === 'chua_tt' ? null : (savedRow.payment_method || null),
      amount_paid: savedRow.amount_paid,
      paid_at: savedRow.paid_at || null,
      paid_by: savedRow.paid_by || null,
    };
    const patch = {
      invoice_code: issued.code,
      kiot_summary: `${issued.code} · ${formatVnd(savedRow.total)}`,
      review_form: nextForm,
      qr_image_url: invoices.imageUrl(issued.code),
      actor_name: actorName || '',
    };
    if (draft.approval_status !== 'SENT') patch.draft_reply = reply;
    let saved = null;
    try {
      const updated = await drafts.updateDraft(draft.id, patch, { actorName });
      saved = updated && updated.draft;
    } catch (err) {
      return {
        status: 200,
        body: {
          ok: true,
          created: true,
          saved: false,
          code: issued.code,
          total: savedRow.total,
          error: 'Đã xuất hoá đơn nhưng chưa ghi vào nháp. Đừng xuất lại — mã ' + issued.code,
        },
      };
    }
    remembered.set(draft.id, { code: issued.code, total: savedRow.total, kind: 'invoice' });
    return {
      status: 200,
      body: {
        ok: true,
        created: true,
        saved: true,
        code: issued.code,
        total: savedRow.total,
        document: 'invoice',
        page_url: link,
        image_url: invoices.imageUrl(issued.code),
        draft: saved,
      },
    };
  });
}

module.exports = {
  BANK_BLOCK,
  paymentDraft,
  suggestLines,
  prefill,
  prepareOrCreate,
  issueInvoice,
  quickFill,
  existingSale,
  shippingFeeFor,
};
