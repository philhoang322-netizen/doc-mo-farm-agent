/**
 * FAQ import and rules accept a larger body than the global JSON default.
 * The global parser skips these POSTs so this limit is the one that applies.
 */
const express = require('express');

const LIMIT = '2mb';
const PATHS = new Set(['/admin/api/faq/import', '/admin/api/faq/rules']);

function skipGlobalJson(req) {
  return req.method === 'POST' && PATHS.has(req.path);
}

const json = express.json({ limit: LIMIT });
const text = express.text({
  type: ['text/csv', 'text/plain', 'application/csv'],
  limit: LIMIT,
});

module.exports = { LIMIT, skipGlobalJson, json, text };
