'use strict';

// KAB socket binding (incl. the macOS SO_REUSEPORT fallback) and the optional bindAddress.
// Everything stays on this machine: loopback traffic, binds to an address no host owns
// (which fails locally), and one datagram addressed to this host's own IP.

const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const os = require('node:os');
const path = require('node:path');
const { makeApi, makeLogger } = require('./helpers/fake-api.js');

const dist = path.join(__dirname, '..', 'dist');
const { EcoPlugPlatform } = require(path.join(dist, 'platform.js'));
const { kabSocket } = require(path.join(dist, 'protocol', 'kab', 'socket.js'));
const { createLegacyManager } = require(path.join(dist, 'protocol', 'legacy', 'protocol.js'));

// From TEST-NET-1 (RFC 5737): never assigned to a real host, so binding to it must fail.
const UNASSIGNED = '192.0.2.1';

async function startEchoServer(t) {
  const echo = dgram.createSocket('udp4');
  await new Promise((resolve) => echo.bind(0, '127.0.0.1', resolve));
  echo.on('message', (msg, rinfo) => echo.send(msg, rinfo.port, rinfo.address));
  t.after(() => echo.close());
  return echo.address().port;
}

function resetKabSocket() {
  kabSocket.setBindAddress(undefined);
  kabSocket.setErrorLogger(() => {});
}

test('KAB socket binds and round-trips without a bindAddress (SO_REUSEPORT fallback on macOS)', { timeout: 10000 }, async (t) => {
  t.after(resetKabSocket);
  const echoPort = await startEchoServer(t);
  kabSocket.setBindPort(0);
  kabSocket.setBindAddress(undefined);

  const reply = await kabSocket.sendAndReceive(Buffer.from('ping'), '127.0.0.1', echoPort, 2000);
  assert.equal(reply.toString(), 'ping');
});

test('KAB socket pinned to 127.0.0.1 binds there and round-trips', { timeout: 10000 }, async (t) => {
  t.after(resetKabSocket);
  const echoPort = await startEchoServer(t);
  kabSocket.setBindPort(0);
  kabSocket.setBindAddress('127.0.0.1');

  const reply = await kabSocket.sendAndReceive(Buffer.from('ping'), '127.0.0.1', echoPort, 2000);
  assert.equal(reply.toString(), 'ping');
  assert.equal(kabSocket.socket.address().address, '127.0.0.1');
});

test('KAB socket rejects (instead of hanging) when bindAddress is not assigned to this host, then recovers', { timeout: 10000 }, async (t) => {
  t.after(resetKabSocket);
  const warnings = [];
  kabSocket.setErrorLogger((msg) => warnings.push(msg));
  kabSocket.setBindPort(0);
  kabSocket.setBindAddress(UNASSIGNED);

  await assert.rejects(kabSocket.send(Buffer.from('x'), '127.0.0.1', 9), /bind/i);
  // a second attempt must fail the same way rather than wait on the first, failed bind
  await assert.rejects(kabSocket.send(Buffer.from('x'), '127.0.0.1', 9), /bind/i);
  assert.ok(
    warnings.some((m) => m.includes('could not bind') && m.includes(UNASSIGNED)),
    `expected a warn-level bind failure message, got: ${JSON.stringify(warnings)}`,
  );

  // the failure is not sticky: once the address is valid the socket binds and works
  const echoPort = await startEchoServer(t);
  kabSocket.setBindAddress('127.0.0.1');
  const reply = await kabSocket.sendAndReceive(Buffer.from('ok'), '127.0.0.1', echoPort, 2000);
  assert.equal(reply.toString(), 'ok');
});

test('platform ignores a bindAddress that is not an IPv4 address, with a warning', (t) => {
  t.after(resetKabSocket);
  for (const bad of ['not-an-ip', '::1', '192.168.1', '192.168.1.1.1']) {
    const { log, logs } = makeLogger();
    const platform = new EcoPlugPlatform(log, { platform: 'EcoPlug', name: 'EcoPlug', bindAddress: bad }, makeApi());
    platform.legacyManager.close();

    assert.equal(kabSocket.bindAddress, undefined, `"${bad}" must not be used`);
    assert.ok(
      logs.some((l) => l.startsWith('warn:') && l.includes('Ignoring bindAddress')),
      `expected a warning for "${bad}", got: ${JSON.stringify(logs)}`,
    );
  }
});

test('platform applies a valid bindAddress (trimmed) and treats a blank one as unset', (t) => {
  t.after(resetKabSocket);

  const pinned = makeLogger();
  const a = new EcoPlugPlatform(pinned.log, { platform: 'EcoPlug', name: 'EcoPlug', bindAddress: '  127.0.0.1 ' }, makeApi());
  a.legacyManager.close();
  assert.equal(kabSocket.bindAddress, '127.0.0.1');
  assert.ok(pinned.logs.some((l) => l.startsWith('info:') && l.includes('pinned to local address 127.0.0.1')));

  const blank = makeLogger();
  const b = new EcoPlugPlatform(blank.log, { platform: 'EcoPlug', name: 'EcoPlug', bindAddress: '   ' }, makeApi());
  b.legacyManager.close();
  assert.equal(kabSocket.bindAddress, undefined);
  assert.equal(blank.logs.filter((l) => l.startsWith('warn:')).length, 0);
});

test('legacy manager reports an unassigned bindAddress instead of hanging', { timeout: 10000 }, async () => {
  const manager = createLegacyManager(0, true, undefined, UNASSIGNED);
  try {
    await assert.rejects(manager.discover(), /bind/i);
  } finally {
    manager.close();
  }
});

test('a legacy listener pinned to 127.0.0.1 receives datagrams addressed to it and ignores other local addresses', { timeout: 15000 }, async (t) => {
  const port = 49152 + Math.floor(Math.random() * 10000);
  const received = [];
  const manager = createLegacyManager(port, true, undefined, '127.0.0.1');
  t.after(() => manager.close());
  manager.startStatusListener((msg) => received.push(msg));

  const frame = Buffer.alloc(130, 0);   // 130-byte legacy status frame
  frame.write('ECO-78ABCDEF', 16, 'ascii');
  frame[129] = 1;                        // power on
  const sender = dgram.createSocket('udp4');
  t.after(() => sender.close());
  const sendTo = (host) => new Promise((resolve) => sender.send(frame, port, host, () => resolve()));

  // the listener binds asynchronously; keep sending until the first frame arrives
  const deadline = Date.now() + 5000;
  while (received.length === 0 && Date.now() < deadline) {
    await sendTo('127.0.0.1');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(received.length > 0, 'pinned listener should receive datagrams sent to 127.0.0.1');
  assert.deepEqual(received[0], { id: 'ECO-78ABCDEF', status: true });

  // a datagram addressed to this host's other IP is delivered locally, never on the wire
  const lanIp = Object.values(os.networkInterfaces()).flat()
    .find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
  if (!lanIp) {
    t.diagnostic('no non-loopback IPv4 address on this host; skipping the "other address" check');
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, 200));   // drain frames still in flight
  const before = received.length;
  await sendTo(lanIp);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(received.length, before, `listener pinned to 127.0.0.1 must not receive datagrams addressed to ${lanIp}`);
});
