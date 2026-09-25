/**
 * Named /admin logins. Passwords are scrypt hashes. ADMIN_PASSWORD remains
 * the bootstrap manager and is not stored here.
 *
 * DATABASE_URL set → Postgres admin_users (migration 025). Otherwise a JSON
 * file next to the drafts file (tests and a process with no database).
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('./database');

const ROLES = new Set(['manager', 'sale', 'dv']);

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS admin_users (
    id            UUID PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL CHECK (role IN ('manager', 'sale', 'dv')),
    display_name  TEXT,
    disabled      BOOLEAN NOT NULL DEFAULT FALSE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS admin_settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
];

let ready = null;

function filePath() {
  if (process.env.ADMIN_USERS_PATH) return process.env.ADMIN_USERS_PATH;
  if (process.env.DRAFTS_JSON_PATH) {
    return path.join(path.dirname(process.env.DRAFTS_JSON_PATH), 'admin_users.json');
  }
  return path.join(require('os').tmpdir(), `dmf-admin-users-${process.pid}.json`);
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('base64url');
  const hash = crypto.scryptSync(String(password), salt, 32).toString('base64url');
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts[0] !== 'scrypt' || !parts[1] || !parts[2]) return false;
  const got = crypto.scryptSync(String(password), parts[1], 32);
  const exp = Buffer.from(parts[2], 'base64url');
  if (got.length !== exp.length) return false;
  return crypto.timingSafeEqual(got, exp);
}

function blank() {
  return { users: [], staffCanSend: false };
}

function readFile() {
  try {
    const data = JSON.parse(fs.readFileSync(filePath(), 'utf8'));
    if (!data || !Array.isArray(data.users)) return blank();
    data.staffCanSend = !!data.staffCanSend;
    return data;
  } catch {
    return blank();
  }
}

function writeFile(data) {
  fs.mkdirSync(path.dirname(filePath()), { recursive: true });
  fs.writeFileSync(filePath(), JSON.stringify(data));
}

function publicUser(row) {
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    display_name: row.display_name || row.username,
    disabled: !!row.disabled,
  };
}

function fromDb(row) {
  return publicUser({
    id: row.id,
    username: row.username,
    role: row.role,
    display_name: row.display_name,
    disabled: row.disabled === true,
    password_hash: row.password_hash,
  });
}

function bad(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function checkUsername(username) {
  const name = String(username || '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{2,40}$/.test(name)) {
    throw bad(400, 'Tên đăng nhập chỉ gồm chữ thường, số, dấu chấm');
  }
  return name;
}

function checkRole(role) {
  if (!ROLES.has(role)) throw bad(400, 'Vai trò không hợp lệ');
  return role;
}

function checkPassword(password) {
  if (typeof password !== 'string' || password.length < 8 || password.length > 200) {
    throw bad(400, 'Mật khẩu cần từ 8 ký tự');
  }
  return password;
}

async function ensureReady() {
  if (!db.DB_ENABLED) return;
  if (ready) return ready;
  ready = (async () => {
    for (const sql of SCHEMA) await db.pool.query(sql);
  })().catch((err) => {
    ready = null;
    throw err;
  });
  return ready;
}

async function list() {
  await ensureReady();
  if (!db.DB_ENABLED) return readFile().users.map(publicUser);
  const r = await db.pool.query(
    'SELECT id, username, role, display_name, disabled FROM admin_users ORDER BY username'
  );
  return r.rows.map(fromDb);
}

async function getByUsername(username) {
  const name = String(username || '').trim().toLowerCase();
  if (!name) return null;
  await ensureReady();
  if (!db.DB_ENABLED) {
    const row = readFile().users.find(user => user.username === name);
    return row ? publicUser(row) : null;
  }
  const r = await db.pool.query(
    'SELECT id, username, role, display_name, disabled FROM admin_users WHERE username = $1',
    [name]
  );
  return r.rows[0] ? fromDb(r.rows[0]) : null;
}

async function staffCanSend() {
  await ensureReady();
  if (!db.DB_ENABLED) return !!readFile().staffCanSend;
  const r = await db.pool.query(
    `SELECT value FROM admin_settings WHERE key = 'staff_can_send'`
  );
  return r.rows[0]?.value === '1';
}

async function setStaffCanSend(on) {
  await ensureReady();
  const value = !!on;
  if (!db.DB_ENABLED) {
    const data = readFile();
    data.staffCanSend = value;
    writeFile(data);
    return value;
  }
  await db.pool.query(
    `INSERT INTO admin_settings (key, value) VALUES ('staff_can_send', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [value ? '1' : '0']
  );
  return value;
}

async function create({ username, password, role, display_name }) {
  const name = checkUsername(username);
  const useRole = checkRole(role);
  const secret = checkPassword(password);
  await ensureReady();
  const row = {
    id: crypto.randomUUID(),
    username: name,
    password_hash: hashPassword(secret),
    role: useRole,
    display_name: String(display_name || name).slice(0, 80),
    disabled: false,
  };
  if (!db.DB_ENABLED) {
    const data = readFile();
    if (data.users.some(user => user.username === name)) {
      throw bad(409, 'Tên đăng nhập đã có');
    }
    data.users.push(row);
    writeFile(data);
    return publicUser(row);
  }
  try {
    await db.pool.query(
      `INSERT INTO admin_users (id, username, password_hash, role, display_name, disabled)
       VALUES ($1,$2,$3,$4,$5,FALSE)`,
      [row.id, row.username, row.password_hash, row.role, row.display_name]
    );
  } catch (err) {
    if (err && err.code === '23505') throw bad(409, 'Tên đăng nhập đã có');
    throw err;
  }
  return publicUser(row);
}

async function setRole(id, role) {
  const useRole = checkRole(role);
  await ensureReady();
  if (!db.DB_ENABLED) {
    const data = readFile();
    const row = data.users.find(user => user.id === id);
    if (!row) return null;
    row.role = useRole;
    writeFile(data);
    return publicUser(row);
  }
  const r = await db.pool.query(
    'UPDATE admin_users SET role = $2 WHERE id = $1 RETURNING id, username, role, display_name, disabled',
    [id, useRole]
  );
  return r.rows[0] ? fromDb(r.rows[0]) : null;
}

async function setDisabled(id, disabled) {
  await ensureReady();
  const off = !!disabled;
  if (!db.DB_ENABLED) {
    const data = readFile();
    const row = data.users.find(user => user.id === id);
    if (!row) return null;
    row.disabled = off;
    writeFile(data);
    return publicUser(row);
  }
  const r = await db.pool.query(
    'UPDATE admin_users SET disabled = $2 WHERE id = $1 RETURNING id, username, role, display_name, disabled',
    [id, off]
  );
  return r.rows[0] ? fromDb(r.rows[0]) : null;
}

async function setPassword(id, password) {
  const secret = checkPassword(password);
  const hash = hashPassword(secret);
  await ensureReady();
  if (!db.DB_ENABLED) {
    const data = readFile();
    const row = data.users.find(user => user.id === id);
    if (!row) return null;
    row.password_hash = hash;
    writeFile(data);
    return publicUser(row);
  }
  const r = await db.pool.query(
    `UPDATE admin_users SET password_hash = $2 WHERE id = $1
     RETURNING id, username, role, display_name, disabled`,
    [id, hash]
  );
  return r.rows[0] ? fromDb(r.rows[0]) : null;
}

async function authenticate(username, password) {
  const name = String(username || '').trim().toLowerCase();
  await ensureReady();
  let row = null;
  if (!db.DB_ENABLED) {
    row = readFile().users.find(user => user.username === name) || null;
  } else {
    const r = await db.pool.query('SELECT * FROM admin_users WHERE username = $1', [name]);
    row = r.rows[0] || null;
  }
  if (!row || row.disabled) return null;
  if (!verifyPassword(password, row.password_hash)) return null;
  return publicUser(row);
}

module.exports = {
  hashPassword,
  verifyPassword,
  list,
  getByUsername,
  create,
  setRole,
  setDisabled,
  setPassword,
  authenticate,
  staffCanSend,
  setStaffCanSend,
  filePath,
};
