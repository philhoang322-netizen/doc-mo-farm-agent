/**
 * Admin product lockup. The version string comes only from package.json
 * so the login page, review header, and admin JS cannot drift apart.
 */
const pkg = require('../package.json');

const PRODUCT_NAME = 'Omni Sale DMF';
const FARM_NAME = 'Dốc Mơ Farm';
const VERSION = String(pkg.version || '').trim();

if (!VERSION) {
  throw new Error('package.json is missing a version');
}

function versionLabel() {
  return VERSION.startsWith('v') ? VERSION : `v${VERSION}`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function clientConfig() {
  return {
    product: PRODUCT_NAME,
    farm: FARM_NAME,
    version: VERSION,
    label: versionLabel(),
  };
}

function clientJson() {
  return JSON.stringify(clientConfig()).replace(/</g, '\\u003c');
}

function applyTemplate(html) {
  return String(html)
    .replaceAll('{{PRODUCT_NAME}}', esc(PRODUCT_NAME))
    .replaceAll('{{FARM_NAME}}', esc(FARM_NAME))
    .replaceAll('{{VERSION}}', esc(VERSION))
    .replaceAll('{{VERSION_LABEL}}', esc(versionLabel()))
    .replaceAll('{{BRAND_JSON}}', clientJson());
}

module.exports = {
  PRODUCT_NAME,
  FARM_NAME,
  VERSION,
  versionLabel,
  clientConfig,
  applyTemplate,
};
