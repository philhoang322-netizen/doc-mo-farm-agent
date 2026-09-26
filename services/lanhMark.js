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

/**
 * Same token predicate as textHasLanh, with the original substring and offsets.
 * A labeling sign-off is narrower: see isSignoff.
 */
function findLanhTokens(text) {
  const src = String(text || '');
  const hits = [];
  const re = /[\p{L}\p{N}]+/gu;
  let match;
  while ((match = re.exec(src))) {
    if (!isLanhToken(match[0])) continue;
    hits.push({
      token: match[0],
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return hits;
}

const SIGNOFF_PARTICLES = new Set(['a', 'nha', 'nhe', 'aa']);

function rawTokens(text) {
  return String(text || '').match(/[\p{L}\p{N}]+/gu) || [];
}

function withoutTrailingParticles(words) {
  const core = words.slice();
  while (core.length && SIGNOFF_PARTICLES.has(ops.normalizeText(core[core.length - 1]))) core.pop();
  return core;
}

function lineIsName(line) {
  const core = withoutTrailingParticles(rawTokens(line));
  return core.length === 1 && isLanhToken(core[0]);
}

/**
 * Sign-off only. The name is the last word (punctuation and emoji ignored,
 * and ạ / nha / nhé / ạa may follow it), or a line that is only the name
 * plus those particles. An inline mention does not count. A lowercase
 * "lành" counts only on a name-only line, so "hiền lành" and "lành tính" do not.
 */
function isSignoff(text) {
  const src = String(text || '');
  if (!src.trim()) return false;
  if (src.split('\n').some(lineIsName)) return true;
  const core = withoutTrailingParticles(rawTokens(src));
  if (!core.length) return false;
  const last = core[core.length - 1];
  if (!isLanhToken(last)) return false;
  if (last === last.toLowerCase()) return false;
  return true;
}

module.exports = {
  tokens,
  isLanhToken,
  textHasLanh,
  findLanhTokens,
  isSignoff,
};
