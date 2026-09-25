/**
 * CSV contract for the private FAQ file. The file itself stays out of git.
 *
 * Required headers (English or Vietnamese aliases):
 *   code, group, product, question, answer, action_flag, verify_status
 * Optional:
 *   variants, conditions, source, enabled
 */
const REQUIRED = ['code', 'group', 'product', 'question', 'answer', 'action_flag', 'verify_status'];
const OPTIONAL = ['variants', 'conditions', 'source', 'enabled'];
const EXPECTED = REQUIRED.concat(OPTIONAL);

const ALIASES = {
  code: ['code', 'id', 'ma', 'mafaq', 'faqcode'],
  group: ['group', 'nhom'],
  product: ['product', 'sanpham'],
  question: ['question', 'cauhoi'],
  variants: ['variants', 'bienthe', 'cauhoituongtu', 'cauhoiphu'],
  answer: ['answer', 'cautraloi', 'traloi'],
  conditions: ['conditions', 'dieukien'],
  action_flag: ['actionflag', 'action', 'hanhdong', 'cohanhdong'],
  verify_status: ['verifystatus', 'verify', 'xacminh', 'trangthaixacminh', 'trangthai'],
  source: ['source', 'nguon'],
  enabled: ['enabled', 'bat', 'kichhoat'],
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
  const s = foldHeader(raw).replace(/hoac/g, '');
  if (!s) return null;
  if (s === 'tudong' || s === 'auto') return 'TU_DONG';
  if (s.includes('chuabat') || s === 'tat' || s === 'off') return 'CHUA_BAT';
  if (s.includes('tracuu') || s.includes('live')) return 'LIVE';
  if (s.includes('chuyennguoi') || s.includes('handoff') || s === 'nguoi') return 'CHUYEN_NGUOI';
  return null;
}

function normalizeVerify(raw) {
  const s = foldHeader(raw);
  if (!s) return null;
  if (
    s.includes('canxacminh')
    || s.includes('chuaxacminh')
    || s.includes('needsverification')
    || s.includes('unverified')
    || s === 'chua'
    || s === 'no'
  ) return 'needs_verification';
  if (
    s.includes('daxacminh')
    || s.includes('verified')
    || s === 'xacminh'
    || s === 'daduyet'
    || s === 'ok'
    || s === 'yes'
  ) return 'verified';
  return null;
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
        `Thiếu cột: ${missing.join(', ')}. Cần các cột ${EXPECTED.join(', ')} (tiếng Việt cũng được).`,
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
      errors: [`Cột không nhận ra: ${unknown.join(', ')}. Cần ${EXPECTED.join(', ')}.`],
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
    const action = normalizeAction(record.action_flag);
    if (!action) {
      errors.push(`Dòng ${r + 1}: action_flag không hợp lệ (${cleanCell(record.action_flag, 80)}).`);
      continue;
    }
    const verify = normalizeVerify(record.verify_status);
    if (!verify) {
      errors.push(`Dòng ${r + 1}: verify_status không hợp lệ (${cleanCell(record.verify_status, 80)}).`);
      continue;
    }
    const enabled = normalizeEnabled(record.enabled);
    if (enabled == null) {
      errors.push(`Dòng ${r + 1}: enabled không hợp lệ.`);
      continue;
    }
    const question = cleanCell(record.question, 2000);
    const answer = cleanCell(record.answer, 8000);
    if (!question || !answer) {
      errors.push(`Dòng ${r + 1}: thiếu câu hỏi hoặc câu trả lời.`);
      continue;
    }
    seen.add(code);
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
      source: cleanCell(record.source, 200),
      enabled,
    });
  }
  return { items, errors, headers };
}

function sameItem(a, b) {
  return REQUIRED.concat(['variants', 'conditions', 'source', 'enabled']).every(key => {
    if (key === 'enabled') return !!a.enabled === !!b.enabled;
    return String(a[key] || '') === String(b[key] || '');
  });
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
  parseFaqCsv,
  diffItems,
  normalizeAction,
  normalizeVerify,
};
