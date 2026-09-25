/**
 * CSV contract for the private FAQ file. The file itself stays out of git.
 *
 * The farm export (16 columns) and the short English contract both work.
 * Extra columns are kept on `extra`. Unknown action or verification labels
 * fail the row. They are never treated as TU_DONG or verified.
 *
 * Farm headers:
 *   id, nhom_san_pham, san_pham, nhom_cau_hoi, cau_hoi, bien_the_tu_khoa,
 *   y_dinh_khach, cau_tra_loi_chuan, gia_dieu_kien, hanh_dong, do_tin_cay,
 *   trang_thai_xac_minh, ly_do_can_xac_minh, nguon_chinh, moc_nguon, ghi_chu_noi_bo
 */
const REQUIRED = ['code', 'group', 'product', 'question', 'answer', 'action_flag', 'verify_status'];
const OPTIONAL = ['variants', 'conditions', 'source', 'enabled'];
const EXTRA_KEYS = [
  'question_group',
  'intent',
  'confidence_label',
  'verify_reason',
  'source_as_of',
  'notes',
  'action_label',
  'verify_label',
];
const EXPECTED = REQUIRED.concat(OPTIONAL, EXTRA_KEYS);

const ALIASES = {
  code: ['code', 'id', 'ma', 'mafaq', 'faqcode'],
  group: ['group', 'nhom', 'nhomsanpham'],
  product: ['product', 'sanpham'],
  question: ['question', 'cauhoi'],
  variants: ['variants', 'bienthe', 'bienthetukhoa', 'cauhoituongtu', 'cauhoiphu'],
  answer: ['answer', 'cautraloi', 'cautraloichuan', 'traloi'],
  conditions: ['conditions', 'dieukien', 'giadieukien'],
  action_flag: ['actionflag', 'action', 'hanhdong', 'cohanhdong'],
  verify_status: ['verifystatus', 'verify', 'xacminh', 'trangthaixacminh', 'trangthai'],
  source: ['source', 'nguon', 'nguonchinh'],
  enabled: ['enabled', 'bat', 'kichhoat'],
  question_group: ['questiongroup', 'nhomcauhoi'],
  intent: ['intent', 'ydinhkhach', 'ydinh'],
  confidence_label: ['confidencelabel', 'dotincay', 'dotincaylabel'],
  verify_reason: ['verifyreason', 'lydocanxacminh', 'lydo'],
  source_as_of: ['sourceasof', 'mocnguon', 'moc'],
  notes: ['notes', 'ghichu', 'ghichunoibo', 'note'],
};

/**
 * Folded label → internal action_flag.
 * TRA_CUU_LIVE_HOAC_CHUYEN_NGUOI is LIVE (live lookup, otherwise handoff).
 * CHUA_BAT_BOT is CHUA_BAT.
 */
const ACTION_BY_LABEL = {
  tudong: 'TU_DONG',
  auto: 'TU_DONG',
  chuyennguoi: 'CHUYEN_NGUOI',
  handoff: 'CHUYEN_NGUOI',
  nguoi: 'CHUYEN_NGUOI',
  tracuulivehoacchuyennguoi: 'LIVE',
  tracuulivechuyennguoi: 'LIVE',
  tracuulive: 'LIVE',
  tracuu: 'LIVE',
  live: 'LIVE',
  chuabatbot: 'CHUA_BAT',
  chuabat: 'CHUA_BAT',
  tat: 'CHUA_BAT',
  off: 'CHUA_BAT',
};

/**
 * Folded label → internal verify_status.
 * Only an approved static answer is verified. Routing labels stay
 * needs_verification so they cannot be quoted as a TU_DONG answer.
 */
const VERIFY_BY_LABEL = {
  daxacminh: 'verified',
  verified: 'verified',
  xacminh: 'verified',
  daduyet: 'verified',
  ok: 'verified',
  yes: 'verified',
  canxacminh: 'needs_verification',
  chuaxacminh: 'needs_verification',
  needsverification: 'needs_verification',
  unverified: 'needs_verification',
  chua: 'needs_verification',
  no: 'needs_verification',
  dulieudongtralivechuyennguoi: 'needs_verification',
  chuyennguoitheoquytac: 'needs_verification',
  chuabatbot: 'needs_verification',
};

function foldHeader(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function canonicalHeader(cell) {
  const key = foldHeader(cell);
  if (!key) return null;
  for (const [name, list] of Object.entries(ALIASES)) {
    if (list.includes(key)) return name;
  }
  return null;
}

function detectDelimiter(headerLine) {
  let comma = 0;
  let semi = 0;
  let quote = false;
  for (let i = 0; i < headerLine.length; i++) {
    const c = headerLine[i];
    if (c === '"') {
      if (quote && headerLine[i + 1] === '"') i += 1;
      else quote = !quote;
    } else if (!quote && c === ',') comma += 1;
    else if (!quote && c === ';') semi += 1;
  }
  return semi > comma ? ';' : ',';
}

function parseRows(text, delimiter) {
  const src = String(text || '').replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let cell = '';
  let quote = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quote = false;
      } else cell += c;
    } else if (c === '"') quote = true;
    else if (c === delimiter) {
      row.push(cell);
      cell = '';
    } else if (c === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (c !== '\r') cell += c;
  }
  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter(r => r.some(c => String(c).trim() !== ''));
}

function normalizeAction(raw) {
  const s = foldHeader(raw);
  if (!s) return null;
  return ACTION_BY_LABEL[s] || null;
}

function normalizeVerify(raw) {
  const s = foldHeader(raw);
  if (!s) return null;
  return VERIFY_BY_LABEL[s] || null;
}

function normalizeEnabled(raw) {
  const s = foldHeader(raw);
  if (!s) return true;
  if (['0', 'false', 'khong', 'tat', 'no', 'off'].includes(s)) return false;
  if (['1', 'true', 'co', 'bat', 'yes', 'on'].includes(s)) return true;
  return null;
}

function cleanCell(value, max) {
  return String(value ?? '').replace(/\0/g, '').trim().slice(0, max);
}

function blankExtra() {
  const extra = {};
  for (const key of EXTRA_KEYS) extra[key] = '';
  return extra;
}

function packExtra(value) {
  const extra = blankExtra();
  const src = value && typeof value === 'object' ? value : {};
  for (const key of EXTRA_KEYS) {
    const max = key === 'notes' || key === 'verify_reason' ? 4000 : 500;
    extra[key] = cleanCell(src[key], max);
  }
  return extra;
}

/**
 * @returns {{ items: object[], errors: string[], headers: string[] }}
 */
function parseFaqCsv(text) {
  const src = String(text || '').replace(/^\uFEFF/, '');
  const headerLine = src.split(/\r?\n/, 1)[0] || '';
  if (!headerLine.trim()) {
    return { items: [], errors: ['File CSV trống.'], headers: [] };
  }
  const delimiter = detectDelimiter(headerLine);
  const rows = parseRows(src, delimiter);
  if (!rows.length) return { items: [], errors: ['File CSV trống.'], headers: [] };

  const mapped = rows[0].map(canonicalHeader);
  const headers = mapped.filter(Boolean);
  const missing = REQUIRED.filter(name => !headers.includes(name));
  if (missing.length) {
    return {
      items: [],
      errors: [
        `Thiếu cột: ${missing.join(', ')}. Cần mã, nhóm, sản phẩm, câu hỏi, câu trả lời, hành động và trạng thái xác minh.`,
      ],
      headers,
    };
  }
  const unknown = rows[0]
    .map((cell, i) => (mapped[i] ? null : cleanCell(cell, 40)))
    .filter(Boolean);
  if (unknown.length) {
    return {
      items: [],
      errors: [`Cột không nhận ra: ${unknown.join(', ')}.`],
      headers,
    };
  }
  const dupes = headers.filter((name, i) => headers.indexOf(name) !== i);
  if (dupes.length) {
    return {
      items: [],
      errors: [`Cột bị trùng: ${[...new Set(dupes)].join(', ')}.`],
      headers,
    };
  }

  const items = [];
  const errors = [];
  const seen = new Set();
  for (let r = 1; r < rows.length; r++) {
    const record = {};
    mapped.forEach((name, i) => {
      if (name) record[name] = rows[r][i] == null ? '' : rows[r][i];
    });
    const code = cleanCell(record.code, 64);
    if (!code) {
      errors.push(`Dòng ${r + 1}: thiếu mã.`);
      continue;
    }
    if (seen.has(code)) {
      errors.push(`Dòng ${r + 1}: mã ${code} bị trùng.`);
      continue;
    }
    const actionShown = cleanCell(record.action_flag, 80);
    const action = normalizeAction(record.action_flag);
    if (!action) {
      errors.push(
        `Dòng ${r + 1}: hành động không nhận ra (${actionShown || 'trống'}). Không gán TU_DONG.`
      );
      continue;
    }
    const verifyShown = cleanCell(record.verify_status, 80);
    const verify = normalizeVerify(record.verify_status);
    if (!verify) {
      errors.push(
        `Dòng ${r + 1}: trạng thái xác minh không nhận ra (${verifyShown || 'trống'}). Không gán verified.`
      );
      continue;
    }
    const enabled = normalizeEnabled(record.enabled);
    if (enabled == null) {
      errors.push(`Dòng ${r + 1}: cột bật/tắt không hợp lệ. Không gán tự động.`);
      continue;
    }
    const question = cleanCell(record.question, 2000);
    const answer = cleanCell(record.answer, 8000);
    if (!question || !answer) {
      errors.push(`Dòng ${r + 1}: thiếu câu hỏi hoặc câu trả lời.`);
      continue;
    }
    seen.add(code);
    const extra = packExtra({
      question_group: record.question_group,
      intent: record.intent,
      confidence_label: record.confidence_label,
      verify_reason: record.verify_reason,
      source_as_of: record.source_as_of,
      notes: record.notes,
      action_label: actionShown,
      verify_label: verifyShown,
    });
    items.push({
      code,
      group: cleanCell(record.group, 200),
      product: cleanCell(record.product, 200),
      question,
      variants: cleanCell(record.variants, 4000),
      answer,
      conditions: cleanCell(record.conditions, 2000),
      action_flag: action,
      verify_status: verify,
      source: cleanCell(record.source, 500),
      enabled,
      extra,
    });
  }
  return { items, errors, headers };
}

function sameItem(a, b) {
  const keys = REQUIRED.concat(['variants', 'conditions', 'source', 'enabled']);
  for (const key of keys) {
    if (key === 'enabled') {
      if (!!a.enabled !== !!b.enabled) return false;
    } else if (String(a[key] || '') !== String(b[key] || '')) return false;
  }
  return JSON.stringify(packExtra(a.extra)) === JSON.stringify(packExtra(b.extra));
}

function diffItems(existing, incoming) {
  const byCode = new Map((existing || []).map(item => [item.code, item]));
  const seen = new Set();
  let added = 0;
  let updated = 0;
  let unchanged = 0;
  for (const row of incoming) {
    seen.add(row.code);
    const prev = byCode.get(row.code);
    if (!prev) added += 1;
    else if (sameItem(prev, row)) unchanged += 1;
    else updated += 1;
  }
  let removed = 0;
  for (const prev of existing || []) {
    if (!seen.has(prev.code)) removed += 1;
  }
  return { added, updated, removed, unchanged, total: incoming.length };
}

module.exports = {
  EXPECTED,
  REQUIRED,
  EXTRA_KEYS,
  ACTION_BY_LABEL,
  VERIFY_BY_LABEL,
  parseFaqCsv,
  diffItems,
  normalizeAction,
  normalizeVerify,
  packExtra,
  blankExtra,
};
