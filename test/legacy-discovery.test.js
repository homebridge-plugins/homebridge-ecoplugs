'use strict';

// Legacy (FtNetManager) discovery targets: per-subnet directed broadcasts alongside the limited
// broadcast, and direct (unicast) probes for static-IP legacy devices.
// Sends are stubbed or stay on loopback; nothing is transmitted on the network.

const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const os = require('node:os');
const path = require('node:path');
const { makeApi, makeLogger } = require('./helpers/fake-api.js');

const {
  createLegacyManager,
  directedBroadcastAddress,
  discoveryBroadcastTargets,
} = require(path.join(__dirname, '..', 'dist', 'protocol', 'legacy', 'protocol.js'));
const { EcoPlugPlatform } = require(path.join(__dirname, '..', 'dist', 'platform.js'));

const iface = (address, netmask, extra = {}) => ({
  address, netmask, family: 'IPv4', internal: false, mac: '00:00:00:00:00:00', cidr: null, ...extra,
});

// ── address maths ────────────────────────────────────────────────────────────

test('directed broadcast address is derived from the address and netmask', () => {
  assert.equal(directedBroadcastAddress('192.168.1.20', '255.255.255.0'), '192.168.1.255');
  assert.equal(directedBroadcastAddress('10.0.5.7', '255.255.0.0'), '10.0.255.255');
  assert.equal(directedBroadcastAddress('10.1.2.3', '255.0.0.0'), '10.255.255.255');
  assert.equal(directedBroadcastAddress('192.168.1.20', '255.255.255.128'), '192.168.1.127');
  assert.equal(directedBroadcastAddress('192.168.1.130', '255.255.255.128'), '192.168.1.255');
  assert.equal(directedBroadcastAddress('192.168.1.5', '255.255.255.252'), '192.168.1.7');
});

test('interfaces without a usable broadcast address give none', () => {
  assert.equal(directedBroadcastAddress('100.64.0.1', '255.255.255.255'), null);   // /32
  assert.equal(directedBroadcastAddress('10.0.0.1', '255.255.255.254'), null);     // /31
  assert.equal(directedBroadcastAddress('10.0.0.1', '0.0.0.0'), null);
  assert.equal(directedBroadcastAddress('10.0.0.1', '255.0.255.0'), null);         // not contiguous
  assert.equal(directedBroadcastAddress('10.0.0.1', 'not-a-mask'), null);
  assert.equal(directedBroadcastAddress('300.0.0.1', '255.255.255.0'), null);
  assert.equal(directedBroadcastAddress('10.0.0.1', '255.255.255'), null);
});

// ── target selection ─────────────────────────────────────────────────────────

test('discovery targets always start with the limited broadcast', () => {
  assert.deepEqual(discoveryBroadcastTargets({}, { localOnly: true }), ['255.255.255.255']);
});

test('discovery targets add each interface\'s subnet broadcast', () => {
  const interfaces = {
    lo0: [iface('127.0.0.1', '255.0.0.0', { internal: true })],
    en0: [iface('192.168.1.20', '255.255.255.0'), iface('fe80::1', 'ffff:ffff:ffff:ffff::', { family: 'IPv6' })],
    en1: [iface('10.0.5.7', '255.255.0.0')],
  };
  assert.deepEqual(
    discoveryBroadcastTargets(interfaces, { localOnly: true }),
    ['255.255.255.255', '192.168.1.255', '10.0.255.255'],
  );
});

test('two interfaces on the same subnet are probed once', () => {
  const interfaces = {
    eth0: [iface('192.168.1.20', '255.255.255.0')],
    wlan0: [iface('192.168.1.21', '255.255.255.0')],
  };
  assert.deepEqual(
    discoveryBroadcastTargets(interfaces, { localOnly: true }),
    ['255.255.255.255', '192.168.1.255'],
  );
});

test('point-to-point and host-only interfaces are skipped', () => {
  const interfaces = {
    tailscale0: [iface('100.64.0.1', '255.255.255.255')],
    ppp0: [iface('10.9.9.1', '255.255.255.254')],
    eth0: [iface('192.168.1.20', '255.255.255.0')],
  };
  assert.deepEqual(
    discoveryBroadcastTargets(interfaces, { localOnly: true }),
    ['255.255.255.255', '192.168.1.255'],
  );
});

test('bindAddress limits the directed broadcast to the pinned interface', () => {
  const interfaces = {
    eth0: [iface('192.168.1.20', '255.255.255.0')],
    eth1: [iface('10.0.5.7', '255.255.0.0')],
  };
  assert.deepEqual(
    discoveryBroadcastTargets(interfaces, { bindAddress: '10.0.5.7', localOnly: true }),
    ['255.255.255.255', '10.0.255.255'],
  );
  // an address that matches no interface falls back to the limited broadcast alone
  assert.deepEqual(
    discoveryBroadcastTargets(interfaces, { bindAddress: '192.168.9.9', localOnly: true }),
    ['255.255.255.255'],
  );
  // the wildcard address is not a pin
  assert.deepEqual(
    discoveryBroadcastTargets(interfaces, { bindAddress: '0.0.0.0', localOnly: true }),
    ['255.255.255.255', '192.168.1.255', '10.0.255.255'],
  );
});

test('localOnly keeps probes off public subnets', () => {
  const interfaces = {
    eth0: [iface('192.168.1.20', '255.255.255.0')],
    wan0: [iface('203.0.113.5', '255.255.255.0')],
  };
  assert.deepEqual(
    discoveryBroadcastTargets(interfaces, { localOnly: true }),
    ['255.255.255.255', '192.168.1.255'],
  );
  assert.deepEqual(
    discoveryBroadcastTargets(interfaces, { localOnly: false }),
    ['255.255.255.255', '192.168.1.255', '203.0.113.255'],
  );
});

// ── manager: what is actually probed ─────────────────────────────────────────

test('discovery probes every broadcast target and the static hosts, and finds devices that answer directly', { timeout: 20000 }, async (t) => {
  const port = 49152 + Math.floor(Math.random() * 10000);
  const fakeInterfaces = {
    lo0: [iface('127.0.0.1', '255.0.0.0', { internal: true })],
    en0: [iface('192.168.1.20', '255.255.255.0')],
    docker0: [iface('172.17.0.1', '255.255.0.0')],
  };
  const realNetworkInterfaces = os.networkInterfaces;
  os.networkInterfaces = () => fakeInterfaces;
  t.after(() => { os.networkInterfaces = realNetworkInterfaces; });

  const reply = Buffer.alloc(408);
  reply.write('ECO-78ABCDEF', 10, 'ascii');
  reply.write('Garden Lights', 42, 'ascii');
  reply.writeUInt32LE(1234, 404);
  // bind first: an unbound socket re-enters the stubbed send() while it queues its first packet
  const replier = dgram.createSocket('udp4');
  await new Promise((resolve) => replier.bind(0, '127.0.0.1', resolve));
  t.after(() => replier.close());

  const sent = [];
  const realSend = dgram.Socket.prototype.send;
  dgram.Socket.prototype.send = function (buf, offset, length, sendPort, host, callback) {
    sent.push(`${host}:${sendPort}`);
    if (host === '192.168.1.50' && sendPort === 25) {
      // the static device answers its direct probe, from its own address
      setTimeout(() => realSend.call(replier, reply, port, '127.0.0.1'), 0);
    }
    if (typeof callback === 'function') callback(null);
  };
  t.after(() => { dgram.Socket.prototype.send = realSend; });

  const logs = [];
  const manager = createLegacyManager(port, true, (msg) => logs.push(msg));
  t.after(() => manager.close());

  const found = await manager.discover(['192.168.1.50', '192.168.1.50', 'plug.local', '8.8.8.8']);

  const targets = new Set(sent.map((entry) => entry.split(':')[0]));
  assert.deepEqual(
    [...targets].sort(),
    ['172.17.255.255', '192.168.1.255', '192.168.1.50', '255.255.255.255'].sort(),
  );
  for (const host of targets) {
    assert.ok(sent.includes(`${host}:25`), `${host} should be probed on port 25`);
    assert.ok(sent.includes(`${host}:5888`), `${host} should be probed on port 5888`);
  }
  assert.ok(logs.some((l) => l.includes('plug.local')), 'a hostname is reported as not probed');
  assert.ok(logs.some((l) => l.includes('non-local host 8.8.8.8')), 'a public host is reported as not probed');

  assert.equal(found.length, 1);
  assert.equal(found[0].id, 'ECO-78ABCDEF');
  assert.equal(found[0].port, 1234);
});

test('discovery still sends the plain broadcast when the network interfaces cannot be listed', { timeout: 15000 }, async (t) => {
  const realNetworkInterfaces = os.networkInterfaces;
  os.networkInterfaces = () => { throw new Error('uv_interface_addresses returned Unknown system error 13'); };
  t.after(() => { os.networkInterfaces = realNetworkInterfaces; });

  const sent = [];
  const realSend = dgram.Socket.prototype.send;
  dgram.Socket.prototype.send = function (buf, offset, length, sendPort, host, callback) {
    sent.push(`${host}:${sendPort}`);
    if (typeof callback === 'function') callback(new Error('stubbed send failure'));
  };
  t.after(() => { dgram.Socket.prototype.send = realSend; });

  const logs = [];
  const manager = createLegacyManager(0, true, (msg) => logs.push(msg));
  t.after(() => manager.close());

  assert.deepEqual(await manager.discover(), []);   // resolves, does not reject
  assert.deepEqual([...new Set(sent)].sort(), ['255.255.255.255:25', '255.255.255.255:5888']);
  assert.ok(logs.some((l) => l.includes('cannot list network interfaces')), JSON.stringify(logs));
});

// ── platform wiring ──────────────────────────────────────────────────────────

const ID = 'ECO-78ABCDEF';
const HOST = '192.168.1.50';

function setup(t, config = {}) {
  const api = makeApi();
  const { log, logs } = makeLogger();
  const platform = new EcoPlugPlatform(log, { platform: 'EcoPlug', name: 'EcoPlug', ...config }, api);
  t.after(() => platform.legacyManager.close());

  const calls = [];
  const discoveries = [];
  platform.legacyManager = {
    ...platform.legacyManager,
    discover: async (hosts) => { calls.push(hosts); return discoveries; },
  };
  return { platform, logs, calls, discoveries, context: () => platform.cachedAccessories.get(ID)?.context };
}

test('only static devices that are configured as legacy are probed directly', async (t) => {
  const { platform, calls } = setup(t, {
    devices: [
      { id: 'ECO-78ABCDE1', host: '192.168.1.51', protocol: 'legacy' },
      { id: 'ECO-78ABCDE2', host: '192.168.1.52' },
      { id: 'ECO-78ABCDE3', host: '192.168.1.53', protocol: 'auto' },
      { id: 'ECO-78ABCDE4', host: '192.168.1.54', protocol: 'kab' },
      { id: 'ECO-78ABCDE5', protocol: 'legacy' },
    ],
  });
  await platform.runDiscovery();
  assert.deepEqual(calls, [['192.168.1.51']]);
});

test('without static devices discovery is a plain broadcast', async (t) => {
  const { platform, calls } = setup(t);
  await platform.runDiscovery();
  assert.deepEqual(calls, [[]]);
});

test('a static legacy device learns its advertised command port from the direct probe', async (t) => {
  const { platform, discoveries, context } = setup(t, { devices: [{ id: ID, host: HOST, protocol: 'legacy' }] });
  platform.seedStaticDevices();
  assert.equal(context().port, 80);

  discoveries.push({ id: ID, name: 'Garden Lights', host: HOST, port: 1234, protocol: 'legacy', version: '1.7.1' });
  await platform.runDiscovery();
  assert.equal(context().port, 1234);
});

test('an explicit commandPort still wins over the advertised port for a static legacy device', async (t) => {
  const { platform, discoveries, context } = setup(t, {
    devices: [{ id: ID, host: HOST, protocol: 'legacy', commandPort: 8080 }],
  });
  platform.seedStaticDevices();

  discoveries.push({ id: ID, name: 'Garden Lights', host: HOST, port: 1234, protocol: 'legacy', version: '1.7.1' });
  await platform.runDiscovery();
  assert.equal(context().port, 8080);
});
