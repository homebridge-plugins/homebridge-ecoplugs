'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  parseDiscoveryResponse,
  buildDiscoveryProbe,
  buildGetRequest,
  buildSetRequest,
} = require(path.join(
  __dirname, '..', 'dist', 'protocol', 'legacy', 'packets.js',
));

function discoveryReply(port) {
  const reply = Buffer.alloc(408);
  reply.write('ECO-78ABCDEF', 10, 'ascii');
  reply.write('Garden Lights', 42, 'ascii');
  reply.writeUInt32LE(port, 404);
  return reply;
}

test('legacy discovery uses the device-advertised UDP command port', () => {
  assert.equal(parseDiscoveryResponse(discoveryReply(1234), '192.168.1.50').port, 1234);
});

test('legacy discovery falls back to port 80 for an invalid advertised port', () => {
  assert.equal(parseDiscoveryResponse(discoveryReply(0), '192.168.1.50').port, 80);
});

test('discovery probe carries the local date and time at the documented offsets', () => {
  const probe = buildDiscoveryProbe(new Date(2026, 10, 22, 13, 45, 7));
  assert.equal(probe.length, 128);
  assert.equal(probe.readUInt16LE(24), 2026);
  assert.equal(probe[26], 11);
  assert.equal(probe[27], 22);
  assert.equal(probe.readUInt32LE(28), 13 * 3600 + 45 * 60 + 7);
  // everything else stays zero
  const rest = Buffer.from(probe);
  rest.fill(0, 24, 32);
  assert.ok(rest.every((byte) => byte === 0));
});

test('discovery probe defaults to the current time rather than a fixed date', () => {
  const before = new Date().getFullYear();
  const year = buildDiscoveryProbe().readUInt16LE(24);
  assert.ok(year >= before && year <= before + 1, `unexpected probe year ${year}`);
});

test('discovery probe at the old fixed timestamp matches the previous bytes', () => {
  const old = Buffer.alloc(128, 0);
  old.writeUInt32BE(0x00e0070b, 23);
  old.writeUInt32BE(0x11f79d00, 27);
  assert.deepEqual(buildDiscoveryProbe(new Date(2016, 10, 17, 11, 13, 59)), old);
});

test('legacy requests use the 128-byte command header', () => {
  const get = buildGetRequest('ECO-78ABCDEF');
  assert.equal(get.length, 128);
  assert.equal(get.readUInt32LE(0), 0x50017);   // get power
  assert.equal(get.readUInt16LE(8), 0);         // no payload
  assert.equal(get.toString('ascii', 16, 28), 'ECO-78ABCDEF');
  assert.equal(get.readUInt32BE(124), 0xCDB8422A);

  const set = buildSetRequest('ECO-78ABCDEF', true);
  assert.equal(set.length, 130);
  assert.equal(set.readUInt32LE(0), 0x50016);   // set power
  assert.equal(set.readUInt16LE(8), 2);         // 2-byte payload
  assert.deepEqual([...set.subarray(128)], [0x01, 0x01]);
  assert.deepEqual([...buildSetRequest('ECO-78ABCDEF', false).subarray(128)], [0x01, 0x00]);
});
