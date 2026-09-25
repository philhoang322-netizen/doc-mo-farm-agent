/**
 * Single door for provider calls.
 *
 * Every prompt is masked here, then training/storage opt-out flags the
 * provider actually accepts are set. Anthropic's Messages API has no
 * per-request training switch and rejects unknown body fields; commercial
 * API inputs are not used for model training. OpenAI and xAI accept
 * store:false, which keeps the completion out of stored eval/distillation
 * logs.
 */
const pii = require('./pii');

let transport = null;

const TRAINING_OPT_OUT = {
  openai: { store: false },
  xai: { store: false },
  anthropic: {},
};

function applyTrainingOptOut(provider, body) {
  const flags = TRAINING_OPT_OUT[provider] || {};
  return { ...body, ...flags };
}

function prepareOutbound(provider, params) {
  const masked = pii.maskOutbound(params);
  const body = applyTrainingOptOut(provider, masked.value);
  const report = {
    provider,
    counts: masked.counts,
    changed: masked.changed,
    enabled: masked.enabled,
    trainingOptOut: { ...(TRAINING_OPT_OUT[provider] || {}) },
  };
  if (masked.changed) {
    const parts = Object.entries(masked.counts)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${k}×${n}`);
    console.log(`PII mask (${provider}): ${parts.join(', ')} (raw values not logged)`);
  }
  return { provider, body, report };
}

/**
 * Test-only stand-in for the network call. Receives { provider, body, report }.
 */
function setTransportForTests(fn) {
  if (fn && process.env.NODE_ENV !== 'test') {
    throw new Error('setTransportForTests is only available when NODE_ENV=test');
  }
  transport = fn || null;
}

async function anthropicCreate(client, params) {
  const prepared = prepareOutbound('anthropic', params);
  try {
    const response = transport
      ? await transport(prepared)
      : await client.messages.create(prepared.body);
    try { require('./healthWatch').noteSuccess('llm'); } catch (_) {}
    return { response, piiReport: prepared.report };
  } catch (err) {
    try { require('./healthWatch').noteFailure('llm', 'exception'); } catch (_) {}
    throw err;
  }
}

async function openaiChat(client, params) {
  const prepared = prepareOutbound('openai', params);
  try {
    const response = transport
      ? await transport(prepared)
      : await client.chat.completions.create(prepared.body);
    try { require('./healthWatch').noteSuccess('llm'); } catch (_) {}
    return { response, piiReport: prepared.report };
  } catch (err) {
    try { require('./healthWatch').noteFailure('llm', 'exception'); } catch (_) {}
    throw err;
  }
}

module.exports = {
  TRAINING_OPT_OUT,
  applyTrainingOptOut,
  prepareOutbound,
  setTransportForTests,
  anthropicCreate,
  openaiChat,
};
