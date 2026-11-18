'use strict';

// HomeKit service type selection: platform default, per-device override, and cached accessories.
// No network activity (the platform's didFinishLaunching handler is never fired).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { makeApi, makeLogger } = require('./helpers/fake-api.js');

const root = path.join(__dirname, '..');
const { EcoPlugPlatform } = require(path.join(root, 'dist', 'platform.js'));
const settings = require(path.join(root, 'dist', 'settings.js'));
const schema = require(path.join(root, 'config.schema.json'));

const ID = 'ECO-78ABCDEF';
const discovered = () => ({ id: ID, name: 'Plug', host: '192.168.1.50', port: 80, protocol: 'legacy', version: '1.0' });

function setup(t, config = {}, cached) {
  const api = makeApi();
  const { log, logs } = makeLogger();
  const platform = new EcoPlugPlatform(log, { platform: 'EcoPlug', name: 'EcoPlug', ...config }, api);
  t.after(() => platform.legacyManager.close());
  if (cached) {
    const accessory = new api.platformAccessory('Plug', api.hap.uuid.generate(ID));
    accessory.addService(cached.service === 'switch' ? api.hap.Service.Switch : api.hap.Service.Outlet, ID);
    accessory.context = { id: ID, name: 'Plug', host: '192.168.1.50', port: 80, protocol: 'legacy', ...cached.context };
    platform.configureAccessory(accessory);
  }
  const acc = () => platform.cachedAccessories.get(ID);
  const kinds = () => acc().services
    .map((s) => s.type)
    .filter((type) => type === api.hap.Service.Outlet || type === api.hap.Service.Switch)
    .map((type) => (type === api.hap.Service.Switch ? 'switch' : 'outlet'));
  return { platform, logs, acc, kinds };
}

test('the code default for new devices matches the default the config UI shows', () => {
  assert.equal(settings.DEFAULT_SERVICE_TYPE, schema.schema.properties.defaultServiceType.default);
});

test('a new device gets a Switch when defaultServiceType is not set', (t) => {
  const { platform, kinds, acc } = setup(t);
  platform.handleDiscoveredDevice(discovered(), 'legacy-discovery');
  assert.deepEqual(kinds(), ['switch']);
  assert.equal(acc().context.serviceType, 'switch');
});

test('defaultServiceType "outlet" gives new devices an Outlet', (t) => {
  const { platform, kinds } = setup(t, { defaultServiceType: 'outlet' });
  platform.handleDiscoveredDevice(discovered(), 'legacy-discovery');
  assert.deepEqual(kinds(), ['outlet']);
});

test('a per-device serviceType "outlet" wins over a switch default', (t) => {
  const { platform, kinds } = setup(t, { devices: [{ id: ID, serviceType: 'outlet' }] });
  platform.handleDiscoveredDevice(discovered(), 'legacy-discovery');
  assert.deepEqual(kinds(), ['outlet']);
});

test('a cached Outlet keeps its type when the default is switch', (t) => {
  const { platform, kinds } = setup(t, {}, { service: 'outlet', context: { serviceType: 'outlet' } });
  platform.handleDiscoveredDevice(discovered(), 'legacy-discovery');
  assert.deepEqual(kinds(), ['outlet']);
});

test('a cached accessory with no stored type keeps the service it already has', (t) => {
  const { platform, kinds, acc } = setup(t, {}, { service: 'outlet', context: {} });
  assert.equal(acc().context.serviceType, 'outlet');
  platform.handleDiscoveredDevice(discovered(), 'legacy-discovery');
  assert.deepEqual(kinds(), ['outlet']);
});

test('unsupported service types are reported and treated as outlet', (t) => {
  const { platform, logs, kinds } = setup(t, { defaultServiceType: 'Lightbulb', devices: [{ id: 'ECO-78000001', serviceType: 'Fan' }] });
  assert.ok(logs.some((l) => l.startsWith('warn:') && l.includes('Unsupported defaultServiceType "Lightbulb"')), JSON.stringify(logs));
  assert.ok(logs.some((l) => l.startsWith('warn:') && l.includes('Unsupported serviceType "Fan"')), JSON.stringify(logs));
  platform.handleDiscoveredDevice(discovered(), 'legacy-discovery');
  assert.deepEqual(kinds(), ['outlet']);
});
