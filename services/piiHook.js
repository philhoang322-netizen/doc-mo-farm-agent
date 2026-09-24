/**
 * Soft hook for Module 3 (PII mask before any LLM call).
 *
 * services/pii.js is not on main yet (see the open PII PR). When that file
 * is present, mask() runs on the copy handed to the model. Saved messages
 * and HITL draft intent stay as the customer wrote them.
 * If the module is absent, this is a no-op and the pipeline still runs.
 */
let pii = null;
try {
  pii = require('./pii');
} catch (err) {
  if (err.code !== 'MODULE_NOT_FOUND') throw err;
}

function maskForLlm(input) {
  if (input == null) return input;
  const text = String(input);
  if (!pii) return text;
  try {
    if (typeof pii.mask === 'function') {
      const out = pii.mask(text);
      if (out && typeof out.text === 'string') return out.text;
    }
    if (typeof pii.maskText === 'function') return String(pii.maskText(text));
  } catch (e) {
    console.warn('PII mask skipped:', e.message);
  }
  return text;
}

module.exports = {
  available: () => !!pii,
  maskForLlm,
};
