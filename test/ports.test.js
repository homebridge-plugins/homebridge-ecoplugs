'use strict';

// Command-port handling for static-config and discovered devices.
// Drives the real platform code; the socket's send() is stubbed so nothing is transmitted.

const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const path = require('node:path');
const { makeApi, makeLogger } = require('./helpers/fake-api.js');

const { EcoPlugPlatform } = require(path.join(__dirname, '..', 'dist', 'platform.js'));

const ID = 'ECO-78ABCDEF';
const HOST = '192.168.1.50';

function setup(t, config = {}, cachedContexts = []) {
  const api = makeApi();
  const { log, logs } = makeLogger();
  const platform = new EcoPlugPlatform(log, { platform: 'EcoPlug', name: 'EcoPlug', ...config }, api);
  t.after(() => platform.legacyManager.close());

  for (const ctx of cachedContexts) {
    const accessory = new api.platformAccessory(ctx.name || ctx.id, api.hap.uuid.generate(ctx.id));
    accessory.addService(api.hap.Service.Outlet, ctx.id);
    accessory.context = { ...ctx };
    platform.configureAccessory(accessory);
  }
  return { platform, logs, context: () => platform.cachedAccessories.get(ID)?.context };
}

const staticDevice = (extra = {}) => ({ devices: [{ id: ID, host: HOST, ...extra }] });
const legacyDiscovery = (port = 80) => ({ id: ID, name: 'Plug', host: HOST, port, protocol: 'legacy', version: '1.0' });
const kabBeacon = (port = 1022) => ({
  id: ID, name: 'Plug', host: HOST, port, protocol: 'kab', status: true,
  kabDeviceIdInt: 0xABCDEF, kabKey: 'key', kabPass: 'pass', kabCommandPort: port, kabBeaconOffset264: 5,
});
const portUpdateLogs = (logs) => logs.filter((l) => l.startsWith('info:') && l.includes('Updated port'));

test('static legacy device without commandPort defaults to the legacy port (80), not the KAB port', (t) => {
  const { platform, context } = setup(t, staticDevice({ protocol: 'legacy' }));
  platform.seedStaticDevices();
  assert.equal(context().port, 80);
});

test('static legacy device keeps port 80 when legacy discovery later reports it', (t) => {
  const { platform, context } = setup(t, staticDevice({ protocol: 'legacy' }));
  platform.seedStaticDevices();
  platform.handleDiscoveredDevice(legacyDiscovery(), 'legacy-discovery');
  assert.equal(context().port, 80);
});

test('legacy SET and GET packets for a static device are sent to port 80', async (t) => {
  const sent = [];
  const realSend = dgram.Socket.prototype.send;
  dgram.Socket.prototype.send = function (buf, offset, length, port, host, callback) {
    sent.push(`${host}:${port}`);
    if (typeof callback === 'function') callback(null);
  };
  t.after(() => { dgram.Socket.prototype.send = realSend; });

  // port 0: the legacy socket binds before sending, so use an ephemeral incoming port, not 9000
  const { platform, context } = setup(t, { port: 0, ...staticDevice({ protocol: 'legacy' }) });
  platform.seedStaticDevices();
  platform.legacyManager.setPower(context(), true);
  platform.legacyManager.getStatus(context());
  const deadline = Date.now() + 3000;
  while (sent.length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(sent, [`${HOST}:80`, `${HOST}:80`]);
});

test('an accessory cached with the wrong legacy port (1022) is corrected by a static seed', (t) => {
  const stale = { id: ID, name: 'Plug', host: HOST, port: 1022, protocol: 'legacy' };
  const { platform, context } = setup(t, staticDevice({ protocol: 'legacy' }), [stale]);
  platform.seedStaticDevices();
  assert.equal(context().port, 80);
});

test('an accessory cached with the wrong legacy port (1022) is corrected by discovery', (t) => {
  const stale = { id: ID, name: 'Plug', host: HOST, port: 1022, protocol: 'legacy' };
  const { platform, context } = setup(t, {}, [stale]);
  platform.handleDiscoveredDevice(legacyDiscovery(), 'legacy-discovery');
  assert.equal(context().port, 80);
});

test('an explicit legacy commandPort is not overwritten by discovery', (t) => {
  const { platform, context, logs } = setup(t, staticDevice({ protocol: 'legacy', commandPort: 1234 }));
  platform.seedStaticDevices();
  assert.equal(context().port, 1234);
  platform.handleDiscoveredDevice(legacyDiscovery(), 'legacy-discovery');
  platform.handleDiscoveredDevice(legacyDiscovery(), 'legacy-discovery');
  assert.equal(context().port, 1234);
  assert.equal(portUpdateLogs(logs).length, 0);
});

test('a cached KAB accessory is switched to legacy when the config forces protocol "legacy"', (t) => {
  const cachedKab = { id: ID, name: 'Plug', host: HOST, port: 1022, protocol: 'kab', kabLanIp: HOST, kabLanPort: 1022 };
  const { context, logs } = setup(t, { devices: [{ id: ID, protocol: 'legacy' }] }, [cachedKab]);
  assert.equal(context().protocol, 'legacy');
  assert.equal(context().port, 80);
  assert.ok(logs.some((l) => l.startsWith('info:') && l.includes('to the legacy protocol')), JSON.stringify(logs));
});

test('a forced-legacy switch of a cached accessory honours an explicit commandPort', (t) => {
  const cachedKab = { id: ID, name: 'Plug', host: HOST, port: 1022, protocol: 'kab' };
  const { context } = setup(t, { devices: [{ id: ID, protocol: 'legacy', commandPort: 1234 }] }, [cachedKab]);
  assert.equal(context().protocol, 'legacy');
  assert.equal(context().port, 1234);
});

test('a switched device is then commanded with the legacy protocol on port 80', async (t) => {
  const sent = [];
  const realSend = dgram.Socket.prototype.send;
  dgram.Socket.prototype.send = function (buf, offset, length, port, host, callback) {
    sent.push(`${host}:${port}`);
    if (typeof callback === 'function') callback(null);
  };
  t.after(() => { dgram.Socket.prototype.send = realSend; });

  const cachedKab = { id: ID, name: 'Plug', host: HOST, port: 1022, protocol: 'kab', kabKey: 'key' };
  const { platform, context } = setup(t, { port: 0, devices: [{ id: ID, protocol: 'legacy' }] }, [cachedKab]);
  await platform.setPowerState(context(), true);
  const deadline = Date.now() + 3000;
  while (sent.length < 1 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(sent, [`${HOST}:80`]);
});

test('without a protocol setting, legacy discovery does not switch a cached KAB accessory', (t) => {
  const cachedKab = { id: ID, name: 'Plug', host: HOST, port: 1022, protocol: 'kab' };
  const { platform, context } = setup(t, {}, [cachedKab]);
  platform.handleDiscoveredDevice(legacyDiscovery(), 'legacy-discovery');
  assert.equal(context().protocol, 'kab');
});

test('a device forced to legacy keeps port 80 and gets no KAB address when it also sends KAB beacons', (t) => {
  const { platform, context, logs } = setup(t, staticDevice({ protocol: 'legacy' }));
  platform.seedStaticDevices();
  platform.handleDiscoveredDevice(kabBeacon(1022), 'kab-beacon');
  assert.equal(context().protocol, 'legacy');
  assert.equal(context().port, 80);
  assert.equal(context().kabLanPort, undefined);
  assert.equal(portUpdateLogs(logs).length, 0);
});

test('KAB devices: a configured commandPort differing from the beacon port causes no port churn or log noise', (t) => {
  const { platform, context, logs } = setup(t, staticDevice({ protocol: 'kab', commandPort: 9090 }));
  platform.seedStaticDevices();
  platform.handleDiscoveredDevice(kabBeacon(1022), 'kab-beacon');
  platform.handleDiscoveredDevice(kabBeacon(1022), 'kab-beacon');
  // KAB commands use kabLanPort ?? kabCommandPort ?? port; the beacon's port wins, as before
  assert.equal(context().kabLanPort, 1022);
  assert.equal(portUpdateLogs(logs).length, 0);
});
