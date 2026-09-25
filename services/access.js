/**
 * Server-side roles for /admin. Buttons in the page are not the check.
 * ADMIN_PASSWORD and ADMIN_API_KEY stay manager (bootstrap).
 */
const auth = require('./adminAuth');
const users = require('./adminUsers');

function discountLimit() {
  const n = Number(process.env.DISCOUNT_MANAGER_VND);
  return Number.isFinite(n) && n >= 0 ? n : 50000;
}

async function principal(req) {
  const data = auth.readSession(req);
  if (data && data.username && (data.role === 'manager' || data.role === 'sale' || data.role === 'dv')) {
    const live = await users.getByUsername(data.username);
    if (!live || live.disabled) return null;
    return {
      source: 'user',
      id: live.id,
      role: live.role,
      username: live.username,
      displayName: live.display_name || live.username,
    };
  }
  if (auth.isAuthed(req)) {
    return { source: 'bootstrap', id: null, role: 'manager', username: 'bootstrap', displayName: 'Quản lý' };
  }
  return null;
}

function actor(p) {
  if (!p) return 'manager';
  if (p.source === 'user') return `${p.role}:${p.username}`.slice(0, 120);
  return 'manager';
}

function canSee(p, draft) {
  if (!p || !draft) return false;
  if (p.role === 'manager') return true;
  const channel = draft.channel;
  const line = draft.biz_line;
  if (p.role === 'sale') return channel === 'zalo' || (channel === 'messenger' && line !== 'dv');
  if (p.role === 'dv') return (channel === 'messenger' && line === 'dv') || (channel === 'zalo' && line === 'dv');
  return false;
}

async function canSend(p) {
  if (!p) return false;
  if (p.role === 'manager') return true;
  return (await users.staffCanSend()) && (p.role === 'sale' || p.role === 'dv');
}

function canDelete(p) {
  return !!p && p.role === 'manager';
}

function canManageUsers(p) {
  return !!p && p.role === 'manager';
}

function canKiot(p) {
  return !!p && (p.role === 'manager' || p.role === 'sale');
}

function canDiscount(p, amount) {
  if (!p) return false;
  if (p.role === 'manager') return true;
  const n = Number(amount || 0);
  if (!Number.isFinite(n) || n < 0) return false;
  return n <= discountLimit();
}

function canRefund(p) {
  return !!p && p.role === 'manager';
}

function canMove(p) {
  return !!p && (p.role === 'manager' || p.role === 'sale' || p.role === 'dv');
}

async function sessionPayload(p) {
  return {
    role: p.role,
    username: p.username,
    displayName: p.displayName,
    staffCanSend: await users.staffCanSend(),
    discountLimit: discountLimit(),
    canSend: await canSend(p),
    canDelete: canDelete(p),
    canKiot: canKiot(p),
    canRefund: canRefund(p),
    canManageUsers: canManageUsers(p),
  };
}

module.exports = {
  principal,
  actor,
  canSee,
  canSend,
  canDelete,
  canManageUsers,
  canKiot,
  canDiscount,
  canRefund,
  canMove,
  discountLimit,
  sessionPayload,
};
