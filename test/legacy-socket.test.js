'use strict';

// Legacy (FtNetManager) socket: failed sends must leave a trace, and a failed bind must be recoverable.
// Sends are stubbed or stay on loopback; nothing is transmitted on the network.

const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const path = require('node:path');

const { createLegacyManager } = require(path.join(__dirname, '..', 'dist', 'protocol', 'legacy', 'protocol.js'));

async function waitFor(predicate, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test('legacy send failures (e.g. EHOSTUNREACH) are logged instead of silently dropped', { timeout: 15000 }, async (t) => {
  const realSend = dgram.Socket.prototype.send;
  dgram.Socket.prototype.send = function (buf, offset, length, port, host, callback) {
    if (typeof callback === 'function') callback(new Error(`send EHOSTUNREACH ${host}:${port}`));
  };
  t.after(() => { dgram.Socket.prototype.send = realSend; });

  const logs = [];
  const manager = createLegacyManager(0, true, (msg) => logs.push(msg));
  t.after(() => manager.close());

  // discovery probes (binds an ephemeral local port; the sends themselves are stubbed to fail)
  const found = await manager.discover();
  assert.deepEqual(found, []);
  assert.ok(logs.some((l) => /discovery probe to 255\.255\.255\.255:25 failed: .*EHOSTUNREACH/.test(l)), JSON.stringify(logs));
  assert.ok(logs.some((l) => /discovery probe to 255\.255\.255\.255:5888 failed: .*EHOSTUNREACH/.test(l)), JSON.stringify(logs));

  // unicast status query: retried, then reported once
  manager.getStatus({ id: 'ECO-78ABCDEF', name: 'Plug', host: '192.168.1.50', port: 80, protocol: 'legacy' });
  await waitFor(() => logs.some((l) => /send to 192\.168\.1\.50:80 failed after 3 attempt\(s\): .*EHOSTUNREACH/.test(l)), 5000, 'the unicast send failure log');
});

test('a poll during a bind outage neither sends from an unbound socket nor prevents recovery', { timeout: 20000 }, async (t) => {
  const port = 49152 + Math.floor(Math.random() * 10000);
  const blocker = dgram.createSocket('udp4');
  await new Promise((resolve) => blocker.bind(port, '127.0.0.1', resolve));

  const logs = [];
  const received = [];
  const manager = createLegacyManager(port, true, (msg) => logs.push(msg), '127.0.0.1');
  t.after(() => manager.close());
  manager.startStatusListener((msg) => received.push(msg));
  await waitFor(() => logs.some((l) => l.includes('Failed to bind legacy socket')), 5000, 'the bind failure');

  // a status poll while the port is unavailable must not implicitly bind the socket
  manager.getStatus({ id: 'ECO-78ABCDEF', name: 'Plug', host: '127.0.0.1', port: 9, protocol: 'legacy' });
  await waitFor(() => logs.some((l) => l.includes('skipped, socket is not bound')), 5000, 'the skipped-send log');

  await new Promise((resolve) => blocker.close(resolve));
  manager.startStatusListener((msg) => received.push(msg));

  const frame = Buffer.alloc(130, 0);
  frame.write('ECO-78ABCDEF', 16, 'ascii');
  frame[129] = 1;
  const sender = dgram.createSocket('udp4');
  t.after(() => sender.close());
  const deadline = Date.now() + 5000;
  while (received.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => sender.send(frame, port, '127.0.0.1', () => resolve()));
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(received.length > 0, `listener should recover on its pinned port; logs: ${JSON.stringify(logs)}`);
  assert.ok(!logs.some((l) => l.includes('already bound')), `socket must not have been implicitly bound; logs: ${JSON.stringify(logs)}`);
});

test('the legacy socket recovers after a failed bind once the problem is gone', { timeout: 20000 }, async (t) => {
  const port = 49152 + Math.floor(Math.random() * 10000);

  // occupy the port exclusively so the manager's first bind fails with EADDRINUSE
  const blocker = dgram.createSocket('udp4');
  await new Promise((resolve) => blocker.bind(port, '127.0.0.1', resolve));

  const logs = [];
  const received = [];
  const manager = createLegacyManager(port, true, (msg) => logs.push(msg), '127.0.0.1');
  t.after(() => manager.close());
  manager.startStatusListener((msg) => received.push(msg));
  await waitFor(() => logs.some((l) => l.includes('Failed to bind legacy socket')), 5000, 'the bind failure');

  // free the port and retry (this is what each discovery cycle does)
  await new Promise((resolve) => blocker.close(resolve));
  manager.startStatusListener((msg) => received.push(msg));

  const frame = Buffer.alloc(130, 0);
  frame.write('ECO-78ABCDEF', 16, 'ascii');
  frame[129] = 1;
  const sender = dgram.createSocket('udp4');
  t.after(() => sender.close());
  const deadline = Date.now() + 5000;
  while (received.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => sender.send(frame, port, '127.0.0.1', () => resolve()));
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(received.length > 0, 'the legacy listener should work after the retried bind');
});
