/**
 * Viettel Post address helpers. Catalog format is the live 3-level one
 * (province, district, ward) from partner.viettelpost.vn categories.
 * Checked 2026-09-25: listProvince still returns 63 pre-merger provinces
 * (Hà Giang, Bắc Kạn, …) on both /v2 and /v3, and listWards requires districtId.
 * Create-order docs still send PROVINCE_ID, DISTRICT_ID, and WARD_ID.
 * This file only reads the bundled catalog. It does not call Viettel Post.
 *
 * Sources:
 * https://partner.viettelpost.vn/v2/categories/listProvince
 * https://partner.viettelpost.vn/v2/categories/listDistrict?provinceId=-1
 * https://partner.viettelpost.vn/v2/categories/listWards?districtId=-1
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.vtpAddress = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const ADMIN = /^(?:tinh|thanh pho|tp|quan|huyen|thi xa|thi tran|phuong|xa)\s+/;
  const PROVINCE_ALIAS = {
    hcm: 'ho chi minh',
    'tp hcm': 'ho chi minh',
    tphcm: 'ho chi minh',
    'sai gon': 'ho chi minh',
    hn: 'ha noi',
    'ha noi': 'ha noi',
    dn: 'da nang',
    'da nang': 'da nang',
  };

  let index = null;
  let pending = null;

  function fold(value) {
    return String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/đ/g, 'd')
      .replace(/Đ/g, 'D')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  function stripAdmin(folded) {
    let cur = String(folded || '').trim();
    let prev = '';
    while (cur && cur !== prev) {
      prev = cur;
      cur = cur.replace(ADMIN, '').trim();
    }
    return cur;
  }

  function pretty(name) {
    const s = String(name || '').trim();
    if (!s) return '';
    const letters = s.replace(/[^A-Za-zÀ-ỹĐđ]/g, '');
    if (!letters || letters !== letters.toUpperCase()) return s;
    return s.toLowerCase().replace(/(^|[\s(/-])([a-zà-ỹđ])/g, (all, lead, ch) => lead + ch.toUpperCase());
  }

  function unit(id, name, extra) {
    const text = String(name || '');
    const withoutParen = text.replace(/\s*\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
    const noParen = fold(withoutParen);
    return Object.assign({
      id: String(id),
      name: text,
      label: pretty(withoutParen || text),
      fold: fold(text),
      noParen,
      bare: stripAdmin(noParen),
    }, extra || {});
  }

  function load(raw) {
    const src = raw || {};
    const provinces = (src.p || []).map(row => unit(row[0], row[2], { code: row[1] || '' }));
    const districts = (src.d || []).map(row => unit(row[0], row[3], {
      provinceId: String(row[1]),
      code: row[2] || '',
    }));
    const wards = (src.w || []).map(row => unit(row[0], row[2], { districtId: String(row[1]) }));
    const byId = (list) => {
      const map = new Map();
      list.forEach(item => map.set(item.id, item));
      return map;
    };
    const group = (list, key) => {
      const map = new Map();
      list.forEach(item => {
        const id = item[key];
        if (!map.has(id)) map.set(id, []);
        map.get(id).push(item);
      });
      return map;
    };
    const districtById = byId(districts);
    const wardsByProvince = new Map();
    wards.forEach(item => {
      const district = districtById.get(item.districtId);
      item.provinceId = district ? district.provinceId : '';
      const pid = item.provinceId;
      if (!wardsByProvince.has(pid)) wardsByProvince.set(pid, []);
      wardsByProvince.get(pid).push(item);
    });
    index = {
      provinces,
      districts,
      wards,
      provinceById: byId(provinces),
      districtById,
      wardById: byId(wards),
      districtsByProvince: group(districts, 'provinceId'),
      wardsByDistrict: group(wards, 'districtId'),
      wardsByProvince,
    };
    return index;
  }

  function loaded() {
    return !!index;
  }

  function ready() {
    if (index) return Promise.resolve(index);
    if (pending) return pending;
    if (typeof fetch !== 'function') return Promise.reject(new Error('Chưa có danh mục địa chỉ'));
    pending = fetch('/admin/vtp-units.json')
      .then(res => {
        if (!res.ok) throw new Error('Không tải được danh mục địa chỉ');
        return res.json();
      })
      .then(load)
      .catch(err => {
        pending = null;
        throw err;
      });
    return pending;
  }

  function words(query) {
    return fold(query).split(' ').filter(Boolean);
  }

  function matches(item, query) {
    const bits = words(query);
    if (!bits.length) return true;
    const hay = item.fold + ' ' + item.bare;
    return bits.every(bit => hay.includes(bit));
  }

  function searchList(list, query, limit) {
    const cap = limit || 8;
    const bits = words(query);
    if (!bits.length) return (list || []).slice(0, cap);
    const out = [];
    for (const item of list || []) {
      if (!matches(item, query)) continue;
      out.push(item);
      if (out.length >= cap) break;
    }
    return out;
  }

  function searchProvinces(query, limit) {
    return searchList(index && index.provinces, query, limit);
  }

  function searchDistricts(query, provinceId, limit) {
    if (!index) return [];
    const list = provinceId ? (index.districtsByProvince.get(String(provinceId)) || []) : index.districts;
    return searchList(list, query, limit);
  }

  function searchWards(query, districtId, provinceId, limit) {
    if (!index) return [];
    let list = index.wards;
    if (districtId) list = index.wardsByDistrict.get(String(districtId)) || [];
    else if (provinceId) list = index.wardsByProvince.get(String(provinceId)) || [];
    return searchList(list, query, limit);
  }

  function getProvince(id) { return index && index.provinceById.get(String(id || '')) || null; }
  function getDistrict(id) { return index && index.districtById.get(String(id || '')) || null; }
  function getWard(id) { return index && index.wardById.get(String(id || '')) || null; }

  function classifyAdmin(token) {
    const folded = fold(token);
    if (/^(?:phuong|xa|thi tran)\b/.test(folded)) return 'ward';
    if (/^(?:quan|huyen|thi xa)\b/.test(folded)) return 'district';
    if (/^(?:tinh|thanh pho|tp)\b/.test(folded)) return 'province';
    return '';
  }

  function matchToken(list, token) {
    const folded = fold(token);
    const alias = PROVINCE_ALIAS[folded];
    const bare = stripAdmin(alias || folded);
    if (!bare || bare.length < 2) return null;
    for (const item of list || []) {
      if (item.noParen === folded || item.bare === bare || item.noParen === bare || item.bare === folded) return item;
      if (alias && (item.bare === alias || item.noParen === alias)) return item;
    }
    return null;
  }

  function peelTokens(list, tokens) {
    if (!list || !tokens.length) return null;
    const max = Math.min(6, tokens.length);
    let best = null;
    for (let n = 1; n <= max; n += 1) {
      const phrase = tokens.slice(tokens.length - n).join(' ');
      const hit = matchToken(list, phrase);
      if (hit && (!best || n > best.n)) best = { item: hit, n };
    }
    return best;
  }

  function fillParents(province, district, ward) {
    if (ward && !district) district = getDistrict(ward.districtId);
    if (district && !province) province = getProvince(district.provinceId);
    if (ward && district && ward.districtId !== district.id) ward = null;
    if (district && province && district.provinceId !== province.id) {
      district = null;
      ward = null;
    }
    return { province, district, ward };
  }

  function cleanDetail(detail) {
    return String(detail || '')
      .replace(/^(?:.*\b(?:giao giúp em|giao tới|giao tại|giao|ship tới|ship|gửi về|gui ve)\s+)/i, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function result(detail, province, district, ward, texts) {
    const linked = fillParents(province, district, ward);
    const extra = texts || {};
    const value = {
      detail: cleanDetail(detail),
      province: linked.province,
      district: linked.district,
      ward: linked.ward,
      provinceText: linked.province ? '' : String(extra.provinceText || '').trim(),
      districtText: linked.district ? '' : String(extra.districtText || '').trim(),
      wardText: linked.ward ? '' : String(extra.wardText || '').trim(),
    };
    value.line = line(value);
    return value;
  }

  // A catalog hit wins. A token that belongs to a later level is left in place.
  // An admin-prefixed token with no catalog row is kept as free text.
  function takeSlot(rest, kind, pool, later) {
    if (!rest.length) return null;
    const token = rest[rest.length - 1];
    const hit = matchToken(pool, token);
    if (hit) {
      rest.pop();
      return { item: hit, text: '' };
    }
    if (later && matchToken(later, token)) return null;
    if (classifyAdmin(token) !== kind) return null;
    rest.pop();
    return { item: null, text: token };
  }

  function parseParts(parts) {
    const rest = parts.slice();
    let province = null;
    let district = null;
    let ward = null;
    let provinceText = '';
    let districtText = '';
    let wardText = '';
    const provinceSlot = takeSlot(rest, 'province', index.provinces, index.districts);
    if (provinceSlot) {
      province = provinceSlot.item;
      provinceText = provinceSlot.text;
    }
    const districtPool = province ? (index.districtsByProvince.get(province.id) || []) : index.districts;
    const wardPreview = province ? (index.wardsByProvince.get(province.id) || []) : index.wards;
    const districtSlot = takeSlot(rest, 'district', districtPool, wardPreview);
    if (districtSlot) {
      district = districtSlot.item;
      districtText = districtSlot.text;
    }
    const wardPool = district
      ? (index.wardsByDistrict.get(district.id) || [])
      : wardPreview;
    const wardSlot = takeSlot(rest, 'ward', wardPool, null);
    if (wardSlot) {
      ward = wardSlot.item;
      wardText = wardSlot.text;
    }
    return result(rest.join(', '), province, district, ward, { provinceText, districtText, wardText });
  }

  function parseTokens(text) {
    const tokens = fold(text).split(' ').filter(Boolean);
    const original = String(text || '').trim().split(/[\s,]+/).filter(Boolean);
    const usable = original.length === tokens.length ? original : tokens;
    let province = null;
    let district = null;
    let ward = null;
    let left = usable.slice();
    const provinceHit = peelTokens(index.provinces, left);
    if (provinceHit) {
      province = provinceHit.item;
      left = left.slice(0, left.length - provinceHit.n);
    }
    const districtPool = province ? (index.districtsByProvince.get(province.id) || []) : index.districts;
    const districtHit = peelTokens(districtPool, left);
    if (districtHit) {
      district = districtHit.item;
      left = left.slice(0, left.length - districtHit.n);
    }
    const wardPool = district
      ? (index.wardsByDistrict.get(district.id) || [])
      : (province ? (index.wardsByProvince.get(province.id) || []) : []);
    const wardHit = peelTokens(wardPool, left);
    if (wardHit) {
      ward = wardHit.item;
      left = left.slice(0, left.length - wardHit.n);
    }
    const texts = { provinceText: '', districtText: '', wardText: '' };
    if (!ward) {
      const free = peelFreeAdmin('ward', left);
      if (free) {
        texts.wardText = free.text;
        left = left.slice(0, left.length - free.n);
      }
    }
    if (!district) {
      const free = peelFreeAdmin('district', left);
      if (free) {
        texts.districtText = free.text;
        left = left.slice(0, left.length - free.n);
      }
    }
    if (!province) {
      const free = peelFreeAdmin('province', left);
      if (free) {
        texts.provinceText = free.text;
        left = left.slice(0, left.length - free.n);
      }
    }
    const detail = (original.length === tokens.length ? left : []).join(' ');
    return result(detail, province, district, ward, texts);
  }

  function peelFreeAdmin(kind, tokens) {
    if (!tokens.length) return null;
    const max = Math.min(6, tokens.length);
    for (let n = max; n >= 1; n -= 1) {
      const phrase = tokens.slice(tokens.length - n).join(' ');
      if (classifyAdmin(phrase) === kind) return { text: phrase, n };
    }
    return null;
  }

  function parse(text) {
    if (!index) return result('', null, null, null);
    const raw = String(text || '')
      .replace(/\([^)]*\)/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/(?:\s+(?:nha|nhe|nhé|ạ|shop))+$/i, '')
      .trim();
    if (!raw) return result('', null, null, null);
    const chunks = raw.split(/\n+/).map(s => s.trim()).filter(Boolean);
    let best = null;
    chunks.forEach(chunk => {
      const parts = chunk.split(/\s*,\s*/).map(s => s.trim()).filter(Boolean);
      const parsed = parts.length >= 2 ? parseParts(parts) : parseTokens(chunk);
      const score = (parsed.ward || parsed.wardText ? 2 : 0)
        + (parsed.district || parsed.districtText ? 1 : 0)
        + (parsed.province || parsed.provinceText ? 1 : 0);
      if (score >= 2 && (!best || score > best.score)) best = { parsed, score };
    });
    if (best) return best.parsed;
    const parts = raw.split(/\s*,\s*/).map(s => s.trim()).filter(Boolean);
    return parts.length >= 2 ? parseParts(parts) : parseTokens(raw);
  }

  function line(value) {
    const src = value || {};
    const wardName = src.wardName || (src.ward && src.ward.label) || src.wardText || '';
    const districtName = src.districtName || (src.district && src.district.label) || src.districtText || '';
    const provinceName = src.provinceName || (src.province && src.province.label) || src.provinceText || '';
    return [src.detail, wardName, districtName, provinceName]
      .map(part => String(part || '').trim())
      .filter(Boolean)
      .join(', ');
  }

  function partId(src, key) {
    if (src[key + 'Id']) return String(src[key + 'Id']);
    if (src[key] && src[key].id) return String(src[key].id);
    return '';
  }

  function partText(src, key) {
    if (partId(src, key)) return '';
    return String(src[key + 'Name'] || src[key + 'Text'] || '').trim();
  }

  // KiotViet does not require a delivery address. Gaps are warnings only.
  function gaps(value) {
    const src = value || {};
    const detail = String(src.detail || '').trim();
    const keys = ['province', 'district', 'ward'];
    const started = !!(detail || keys.some(key => partId(src, key) || partText(src, key)));
    const missing = [];
    const invalid = [];
    if (started) {
      keys.forEach(key => {
        if (partId(src, key)) return;
        if (partText(src, key)) invalid.push(key);
        else missing.push(key);
      });
      if (!detail) missing.push('street');
    }
    const label = { province: 'tỉnh', district: 'quận', ward: 'phường', street: 'số nhà' };
    const warnings = [];
    if (missing.length) warnings.push('Thiếu ' + missing.map(key => label[key]).join(', '));
    if (invalid.length) warnings.push('Chưa khớp ' + invalid.map(key => label[key]).join(', '));
    return {
      ok: true,
      errors: [],
      warnings,
      missing,
      invalid,
      focus: (missing[0] || invalid[0] || ''),
    };
  }

  function validate(value) {
    return gaps(value);
  }

  if (typeof document !== 'undefined') ready().catch(() => {});

  return {
    fold,
    pretty,
    load,
    loaded,
    ready,
    searchProvinces,
    searchDistricts,
    searchWards,
    getProvince,
    getDistrict,
    getWard,
    parse,
    line,
    gaps,
    validate,
  };
});
