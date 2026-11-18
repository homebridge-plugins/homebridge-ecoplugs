'use strict';

// KAB beacon listener: a busy port must be reported (not only in the debug log) and retried.
// Uses a random high port on this machine instead of 10228.

const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const path = require('node:path');

const { startKabBeaconListener } = require(path.join(__dirname, '..', 'dist', 'protocol', 'kab', 'beacon.js'));

async function waitFor(predicate, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test('a busy beacon port is reported once at warn level, retried, and recovers', { timeout: 15000 }, async (t) => {
  const port = 49152 + Math.floor(Math.random() * 10000);
  const blocker = dgram.createSocket('udp4');
  await new Promise((resolve) => blocker.bind(port, resolve));

  const debug = [];
  const warn = [];
  const info = [];
  const listener = startKabBeaconListener(() => {}, (m) => debug.push(m), {
    port, retryMs: 100, warn: (m) => warn.push(m), info: (m) => info.push(m),
  });
  t.after(() => listener.close());

  await waitFor(() => warn.length > 0, 5000, 'the warning');
  assert.match(warn[0], new RegExp(`could not bind to UDP port ${port}`));
  // a few retries happen while the port stays busy; they must not repeat the warning
  await waitFor(() => debug.filter((m) => m.includes('could not bind')).length >= 2, 5000, 'repeated failures');
  assert.equal(warn.length, 1, JSON.stringify(warn));

  await new Promise((resolve) => blocker.close(resolve));
  await waitFor(() => info.some((m) => m.includes('recovered')), 5000, 'recovery');

  // it is really listening now: the port is taken again
  const probe = dgram.createSocket('udp4');
  const err = await new Promise((resolve) => {
    probe.once('error', resolve);
    probe.bind(port, () => resolve(null));
  });
  probe.close();
  assert.equal(err?.code, 'EADDRINUSE');
});

test('closing the listener cancels a pending retry', { timeout: 10000 }, async () => {
  const port = 49152 + Math.floor(Math.random() * 10000);
  const blocker = dgram.createSocket('udp4');
  await new Promise((resolve) => blocker.bind(port, resolve));

  const warn = [];
  const listener = startKabBeaconListener(() => {}, () => {}, { port, retryMs: 100, warn: (m) => warn.push(m) });
  await waitFor(() => warn.length > 0, 5000, 'the warning');
  listener.close();
  await new Promise((resolve) => blocker.close(resolve));
  await new Promise((resolve) => setTimeout(resolve, 300));

  // nobody re-bound the port after close()
  const probe = dgram.createSocket('udp4');
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.bind(port, resolve); });
  probe.close();
});
