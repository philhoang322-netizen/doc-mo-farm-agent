/**
 * Staff name "Lành" as a whole word.
 *
 * Matching is case-insensitive and accepts the name without diacritics
 * ("Lanh"). The cold word "lạnh" uses the nặng tone and is not the name,
 * so "trời lạnh" does not count. A letter sequence inside a longer word
 * does not count either.
 */
const ops = require('./ops');

const NANG = /\u0323/;

function tokens(text) {
  return String(text || '').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

function isLanhToken(raw) {
  const token = String(raw || '').trim();
  if (!token) return false;
  if (ops.normalizeText(token) !== 'lanh') return false;
  if (NANG.test(token.normalize('NFD'))) return false;
  return true;
}

function textHasLanh(text) {
  return tokens(text).some(isLanhToken);
}

module.exports = {
  tokens,
  isLanhToken,
  textHasLanh,
};
