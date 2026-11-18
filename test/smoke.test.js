'use strict';

// Smoke tests for the compiled plugin (run with `npm test`, which builds first).
// They use Node's built-in test runner so no extra dependencies are needed.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const root = path.join(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const schema = require(path.join(root, 'config.schema.json'));
const settings = require(path.join(root, 'dist', 'settings.js'));
const register = require(path.join(root, 'dist', 'index.js')).default;

test('plugin entry point registers the EcoPlug platform with Homebridge', () => {
  const calls = [];
  register({ registerPlatform: (...args) => calls.push(args) });

  assert.equal(calls.length, 1, 'registerPlatform should be called exactly once');
  const [pluginName, platformName, platformClass] = calls[0];
  assert.equal(pluginName, pkg.name, 'PLUGIN_NAME must match the npm package name');
  assert.equal(platformName, schema.pluginAlias, 'PLATFORM_NAME must match pluginAlias in config.schema.json');
  assert.equal(typeof platformClass, 'function');
});

test('settings constants match package.json and config.schema.json', () => {
  assert.equal(settings.PLUGIN_NAME, pkg.name);
  assert.equal(settings.PLATFORM_NAME, schema.pluginAlias);
});

test('config.schema.json is a valid Homebridge platform schema', () => {
  assert.equal(schema.pluginType, 'platform');
  assert.equal(schema.schema.type, 'object');
  assert.ok(schema.schema.properties && Object.keys(schema.schema.properties).length > 0);
});
