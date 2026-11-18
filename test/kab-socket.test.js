'use strict';

// Shared KAB command socket: re-binding with new settings, and the ephemeral source-port fallback.
// Sockets bind on this machine only; sends are either to loopback or stubbed out.

const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const path = require('node:path');

const dist = path.join(__dirname, '..', 'dist');
const { kabSocket } = require(path.join(dist, 'protocol', 'kab', 'socket.js'));
const { kabSetPower } = require(path.join(dist, 'protocol', 'kab', 'protocol.js'));

const randomPort = () => 49152 + Math.floor(Math.random() * 10000);

test('a bind already in progress when the settings change ends up using the new settings', { timeout: 10000 }, async (t) => {
  t.after(() => kabSocket.setBindAddress(undefined));
  const echo = dgram.createSocket('udp4');
  await new Promise((resolve) => echo.bind(0, '127.0.0.1', resolve));
  echo.on('message', (msg, rinfo) => echo.send(msg, rinfo.port, rinfo.address));
  t.after(() => echo.close());

  // Make the race deterministic: behave like Linux (no SO_REUSEPORT retry, which on macOS
  // would re-read the settings anyway) and hold the first bind until the address has changed.
  const realCreate = dgram.createSocket;
  const realBind = dgram.Socket.prototype.bind;
  dgram.createSocket = (opts, ...rest) => realCreate(typeof opts === 'object' ? { ...opts, reusePort: false } : opts, ...rest);
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let first = true;
  dgram.Socket.prototype.bind = function (...args) {
    if (first) {
      first = false;
      held.then(() => realBind.apply(this, args));
      return this;
    }
    return realBind.apply(this, args);
  };
  t.after(() => { dgram.createSocket = realCreate; dgram.Socket.prototype.bind = realBind; });

  kabSocket.setBindPort(0);
  kabSocket.setBindAddress(undefined);
  const pending = kabSocket.sendAndReceive(Buffer.from('ping'), '127.0.0.1', echo.address().port, 2000);
  kabSocket.setBindAddress('127.0.0.1'); // while the wildcard bind is still in flight
  release();
  const reply = await pending;
  assert.equal(reply.toString(), 'ping');
  assert.equal(kabSocket.socket.address().address, '127.0.0.1');
});

test('re-binding fails requests still waiting on the old socket immediately instead of at their timeout', { timeout: 10000 }, async (t) => {
  t.after(() => kabSocket.setBindPort(0));
  const silent = dgram.createSocket('udp4'); // receives, never answers
  await new Promise((resolve) => silent.bind(0, '127.0.0.1', resolve));
  t.after(() => silent.close());

  kabSocket.setBindPort(0);
  const started = Date.now();
  const pending = kabSocket.sendAndReceive(Buffer.from('x'), '127.0.0.1', silent.address().port, 8000);
  await new Promise((resolve) => setTimeout(resolve, 100));
  kabSocket.setBindPort(randomPort());
  await assert.rejects(pending, /re-bound/);
  assert.ok(Date.now() - started < 2000, 'should not have waited for the 8s timeout');
});

test('an unanswered command does not leave the shared socket on an ephemeral source port, and never broadcasts', { timeout: 20000 }, async (t) => {
  const sent = [];
  const realSend = dgram.Socket.prototype.send;
  dgram.Socket.prototype.send = function (buf, offset, length, port, host, callback) {
    sent.push(host);
    if (typeof callback === 'function') callback(null); // "sent", but no device ever answers
  };
  t.after(() => { dgram.Socket.prototype.send = realSend; });

  const configured = randomPort();
  kabSocket.setBindPort(configured);
  t.after(() => kabSocket.setBindPort(0));

  const device = {
    id: 'ECO-78ABCDEF', name: 'Plug', host: '192.168.1.50', port: 1022, protocol: 'kab',
    kabKey: 'key', kabPass: '111111', kabDeviceIdInt: 0xABCDEF, kabCommandPort: 1022,
    kabSkipDiscovery: true, kabUseBeaconId: true, kabCommandTimeoutMs: 50,
  };
  const result = await kabSetPower(device, true);
  assert.equal(result.ok, false);
  assert.equal(kabSocket.getBindPort(), configured, 'configured source port must be restored');
  assert.ok(sent.length > 0);
  assert.ok(!sent.includes('255.255.255.255'), `no broadcast expected, sent to: ${JSON.stringify(sent)}`);
});
