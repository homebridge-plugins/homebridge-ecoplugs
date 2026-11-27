'use strict';

// Command-port handling for static-config and discovered devices.
// Drives the real platform code; the socket's send() is stubbed so nothing is transmitted.

const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const path = require('node:path');
const { makeApi, makeLogger } = require('./helpers/fake-api.js');

const { EcoPlugPlatform } = require(path.join(__dirname, '..', 'dist', 'platform.js'));
const { kabSocket } = require(path.join(__dirname, '..', 'dist', 'protocol', 'kab', 'socket.js'));

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
  const { platform, context, logs } = setup(t, staticDevice({ protocol: 'kab', commandPort: 2000 }));
  platform.seedStaticDevices();
  platform.handleDiscoveredDevice(kabBeacon(1022), 'kab-beacon');
  platform.handleDiscoveredDevice(kabBeacon(1022), 'kab-beacon');
  // the beacon's port is still recorded; the configured port is applied when a command is sent
  assert.equal(context().kabLanPort, 1022);
  assert.equal(portUpdateLogs(logs).length, 0);
});

/**
 * Send one KAB command through the platform and return the distinct destinations used.
 * Nothing is transmitted, no device answers, and the response timeout is shortened.
 */
async function kabCommandDestinations(t, platform, context) {
  const sent = [];
  t.mock.method(dgram.Socket.prototype, 'send', function (buf, offset, length, port, host, callback) {
    sent.push(`${host}:${port}`);
    if (typeof callback === 'function') callback(null);
  });
  const realRequest = kabSocket.sendAndReceive;
  t.mock.method(kabSocket, 'sendAndReceive', function (buf, host, port, timeoutMs, filter) {
    return realRequest.call(this, buf, host, port, 20, filter);
  });
  await assert.rejects(platform.setPowerState(context, false));
  return [...new Set(sent)];
}

// kabBindPort 0: never bind the real KAB source port (9090) from a test
const kabConfig = (extra = {}) => ({ kabBindPort: 0, ...extra });
const cachedKabPlug = (extra = {}) => ({
  id: ID, name: 'Plug', host: HOST, port: 1022, protocol: 'kab', kabKey: 'key', kabPass: 'pass',
  kabDeviceIdInt: 0xABCDEF, kabCommandPort: 1022, kabLanIp: HOST, kabLanPort: 1022,
  kabSkipDiscovery: true, kabUseBeaconId: true, ...extra,
});

test('a configured KAB commandPort is used after beacons arrive from a discovered device', async (t) => {
  const { platform, context } = setup(t, kabConfig({ devices: [{ id: ID, commandPort: 2000 }] }));
  platform.handleDiscoveredDevice(kabBeacon(1022), 'kab-beacon');
  platform.handleDiscoveredDevice(kabBeacon(1022), 'kab-beacon');
  assert.deepEqual(await kabCommandDestinations(t, platform, context()), [`${HOST}:2000`]);
});

test('a configured KAB commandPort is used after a static device starts beaconing', async (t) => {
  const { platform, context } = setup(t, kabConfig(staticDevice({ protocol: 'kab', commandPort: 2000 })));
  platform.seedStaticDevices();
  platform.handleDiscoveredDevice(kabBeacon(1022), 'kab-beacon');
  platform.handleDiscoveredDevice(kabBeacon(1022), 'kab-beacon');
  assert.deepEqual(await kabCommandDestinations(t, platform, context()), [`${HOST}:2000`]);
});

test('a newly configured KAB commandPort applies to a cached accessory before its next beacon', async (t) => {
  const config = kabConfig({ devices: [{ id: ID.toLowerCase(), commandPort: 2000 }] });
  const { platform, context } = setup(t, config, [cachedKabPlug()]);
  assert.deepEqual(await kabCommandDestinations(t, platform, context()), [`${HOST}:2000`]);
});

test('removing a KAB commandPort goes straight back to the port the device advertised', async (t) => {
  // kabPortOverride is what an earlier run with the setting leaves in the accessory cache
  const { platform, context } = setup(t, kabConfig(), [cachedKabPlug({ kabPortOverride: 2000 })]);
  assert.deepEqual(await kabCommandDestinations(t, platform, context()), [`${HOST}:1022`]);
});

const portWarnings = (logs) => logs.filter((l) => l.startsWith('warn:') && l.includes('commandPort'));

test('a KAB commandPort that differs from the advertised port is warned about once', (t) => {
  const { platform, logs } = setup(t, kabConfig({ devices: [{ id: ID, commandPort: 2000 }] }));
  platform.handleDiscoveredDevice(kabBeacon(1022), 'kab-beacon');
  platform.handleDiscoveredDevice(kabBeacon(1022), 'kab-beacon');
  const warnings = portWarnings(logs);
  assert.equal(warnings.length, 1, JSON.stringify(logs));
  assert.match(warnings[0], /2000.*1022/);
});

test('a KAB commandPort that matches the advertised port is not warned about', (t) => {
  const { platform, logs } = setup(t, kabConfig({ devices: [{ id: ID, commandPort: 1022 }] }));
  platform.handleDiscoveredDevice(kabBeacon(1022), 'kab-beacon');
  assert.equal(portWarnings(logs).length, 0);
});

// 9090 is the plugin's own source port; earlier documentation showed it as a KAB commandPort
const assertIgnored9090Warning = (logs) => {
  const warnings = portWarnings(logs);
  assert.equal(warnings.length, 1, JSON.stringify(logs));
  assert.match(warnings[0], /ignoring commandPort 9090/);
};

test('commandPort 9090 is ignored for a discovered KAB device, with one warning', async (t) => {
  const { platform, context, logs } = setup(t, kabConfig({ devices: [{ id: ID, commandPort: 9090 }] }));
  platform.handleDiscoveredDevice(kabBeacon(1022), 'kab-beacon');
  platform.handleDiscoveredDevice(kabBeacon(1022), 'kab-beacon');
  assert.equal(context().kabCommandPort, 1022);
  assert.deepEqual(await kabCommandDestinations(t, platform, context()), [`${HOST}:1022`]);
  assertIgnored9090Warning(logs);
});

test('commandPort 9090 is ignored for a static KAB device that has not beaconed', async (t) => {
  const config = kabConfig(staticDevice({ protocol: 'kab', commandPort: 9090, kabKey: 'key' }));
  const { platform, context, logs } = setup(t, config);
  platform.seedStaticDevices();
  assert.equal(context().port, 1022);
  assert.deepEqual(await kabCommandDestinations(t, platform, context()), [`${HOST}:1022`]);
  assertIgnored9090Warning(logs);
});

test('a 9090 saved with a cached accessory by an earlier version is not used before the next beacon', async (t) => {
  const saved = cachedKabPlug({ kabCommandPort: 9090, kabLanIp: undefined, kabLanPort: undefined });
  const { platform, context, logs } = setup(t, kabConfig({ devices: [{ id: ID, commandPort: 9090 }] }), [saved]);
  assert.deepEqual(await kabCommandDestinations(t, platform, context()), [`${HOST}:1022`]);
  assertIgnored9090Warning(logs);
});

test('commandPort 9090 is still honoured for a legacy device', (t) => {
  const { platform, context, logs } = setup(t, staticDevice({ protocol: 'legacy', commandPort: 9090 }));
  platform.seedStaticDevices();
  platform.handleDiscoveredDevice(legacyDiscovery(), 'legacy-discovery');
  assert.equal(context().port, 9090);
  assert.equal(portWarnings(logs).length, 0);
});
