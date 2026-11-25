'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const schema = require(path.join(__dirname, '..', 'config.schema.json'));
const device = schema.schema.properties.devices.items;

// The Homebridge config form adds one blank devices[] entry on its own, filled
// with any item defaults.  That entry must validate, or the form shows
// "Config validation failed" for a user who never added a device.
test('the blank device entry added by the config form passes validation', () => {
  assert.equal(device.required, undefined);
  for (const [name, property] of Object.entries(device.properties)) {
    assert.equal(property.default, undefined, `${name} must not have a default`);
  }
  // older versions saved the blank entry as { "protocol": "auto" }
  assert.equal(device.dependencies.protocol, undefined);
});

test('a device entry with settings still requires an ID', () => {
  const settingNames = Object.keys(device.properties).filter(n => n !== 'id' && n !== 'protocol');
  for (const name of settingNames) {
    assert.deepEqual(device.dependencies[name], ['id'], `${name} should require id`);
  }
});
