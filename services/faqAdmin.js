/**
 * Manager-only FAQ admin: CSV replace, list, edit, bot rules.
 */
const fs = require('fs');
const path = require('path');
const auth = require('./adminAuth');
const access = require('./access');
const brand = require('./brand');
const store = require('./faqStore');
const csv = require('./faqCsv');

const PUBLIC = path.join(__dirname, '..', 'public', 'admin');

function csvFrom(req) {
  if (req.body && typeof req.body.csv === 'string') return req.body.csv;
  if (typeof req.body === 'string') return req.body;
  return '';
}

function confirmed(req) {
  if (req.query && (req.query.confirm === '1' || req.query.confirm === 'true')) return true;
  if (!req.body || typeof req.body !== 'object') return false;
  return req.body.confirm === true || req.body.confirm === '1' || req.body.confirm === 'true';
}

async function manager(req, res) {
  const principal = await access.principal(req);
  if (!principal) {
    res.status(401).json({ error: 'Chưa đăng nhập' });
    return null;
  }
  if (!access.canFaq(principal)) {
    res.status(403).json({ error: 'Không đủ quyền' });
    return null;
  }
  return principal;
}

async function page(req, res) {
  if (!auth.passwordConfigured()) return res.status(503).type('html').send('Chưa cấu hình ADMIN_PASSWORD');
  if (!auth.passwordAuthed(req)) return res.redirect(303, '/admin');
  const principal = await access.principal(req);
  if (!access.canFaq(principal)) return res.status(403).type('html').send('Không đủ quyền');
  const html = await fs.promises.readFile(path.join(PUBLIC, 'faq.html'), 'utf8');
  res.type('html').send(brand.applyTemplate(html));
}

async function list(req, res) {
  if (!(await manager(req, res))) return;
  const items = await store.list(req.query.q);
  res.json({ items });
}

async function update(req, res) {
  if (!(await manager(req, res))) return;
  const patch = {};
  if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'answer')) patch.answer = req.body.answer;
  if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'enabled')) patch.enabled = req.body.enabled;
  const saved = await store.update(req.params.code, patch);
  if (!saved) return res.status(404).json({ error: 'Không thấy mục FAQ' });
  res.json({ item: saved });
}

async function importCsv(req, res) {
  if (!(await manager(req, res))) return;
  const parsed = csv.parseFaqCsv(csvFrom(req));
  if (parsed.errors.length) {
    return res.status(400).json({ error: parsed.errors[0], errors: parsed.errors });
  }
  const existing = await store.all();
  const diff = csv.diffItems(existing, parsed.items);
  if (!confirmed(req)) {
    return res.json({ ok: true, preview: true, ...diff });
  }
  await store.replaceAll(parsed.items);
  res.json({ ok: true, preview: false, ...diff });
}

async function getRules(req, res) {
  if (!(await manager(req, res))) return;
  res.json(await store.currentRules());
}

async function saveRules(req, res) {
  const principal = await manager(req, res);
  if (!principal) return;
  try {
    const saved = await store.saveRules(req.body && req.body.body, access.actor(principal));
    res.json(saved);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Không lưu được quy tắc' });
  }
}

module.exports = { page, list, update, importCsv, getRules, saveRules };
