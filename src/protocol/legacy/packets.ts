/**
 * Legacy FtNetManager packet builders and parsers.
 *
 * Three message sizes:
 *   128 bytes – setPower ACK / getPower request
 *   130 bytes – setPower request / status response
 *   408 bytes – discovery response
 *
 * Discovery is triggered by sending a 128-byte probe (all zeros except the
 * local date and time at offsets 24-31) to 255.255.255.255:25 (and :5888).
 */

import { LEGACY_DEFAULT_PORT } from '../../settings.js';
import type { DeviceInfo, StatusMessage } from '../types.js';

// ── Message length constants ──────────────────────────────────────────────────
export const LEGACY_ACK_LENGTH       = 128;
export const LEGACY_STATUS_LENGTH    = 130;
export const LEGACY_DISCOVERY_LENGTH = 408;

// ── Command word constants ────────────────────────────────────────────────────
const CMD_SET  = 0x16000500;
const CMD_GET  = 0x17000500;
const TRAILER  = 0xCDB8422A;

// ── Helpers ───────────────────────────────────────────────────────────────────

function readStr(buf: Buffer, offset: number, len: number): string {
    return buf.toString('ascii', offset, offset + len).replace(/\0/g, '').trim();
}

// ── Request builders ──────────────────────────────────────────────────────────

/**
 * Build a 128-byte GET (status query) request.
 */
export function buildGetRequest(deviceId: string): Buffer {
    const buf = Buffer.alloc(128, 0);
    buf.writeUInt32BE(CMD_GET, 0);
    buf.writeUInt32BE(Math.floor(Math.random() * 0xffff), 4);
    buf.writeUInt16BE(0x0000, 8);
    buf.write(deviceId, 16, 16, 'ascii');
    buf.writeUInt32LE(Math.floor(Date.now() / 1000), 116);
    buf.writeUInt32BE(TRAILER, 124);
    return buf;
}

/**
 * Build a 130-byte SET (power) request.
 */
export function buildSetRequest(deviceId: string, on: boolean): Buffer {
    const buf = Buffer.alloc(130, 0);
    buf.writeUInt32BE(CMD_SET, 0);
    buf.writeUInt32BE(Math.floor(Math.random() * 0xffff), 4);
    buf.writeUInt16BE(0x0200, 8);
    buf.write(deviceId, 16, 16, 'ascii');
    buf.writeUInt32LE(Math.floor(Date.now() / 1000), 116);
    buf.writeUInt32BE(TRAILER, 124);
    buf.writeUInt16BE(on ? 0x0101 : 0x0100, 128);
    return buf;
}

/**
 * Build a 128-byte discovery probe: all zeros except the sender's local date
 * and time, as the original ECO Plugs app sends it.
 *
 *   offset 24  uint16 LE  year
 *   offset 26  uint8      month (1-12)
 *   offset 27  uint8      day of month
 *   offset 28  uint32 LE  seconds since local midnight
 *
 * This probe used to be a fixed buffer that always carried 2016-11-17
 * 11:13:59; those bytes decode to exactly this layout.
 */
export function buildDiscoveryProbe(now: Date = new Date()): Buffer {
    const buf = Buffer.alloc(128, 0);
    buf.writeUInt16LE(now.getFullYear(), 24);
    buf.writeUInt8(now.getMonth() + 1, 26);
    buf.writeUInt8(now.getDate(), 27);
    buf.writeUInt32LE(
        now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds(),
        28,
    );
    return buf;
}

// ── Response parsers ──────────────────────────────────────────────────────────

/**
 * Parse a 130-byte status response.
 * Returns the device ID and current power state.
 */
export function parseStatusResponse(msg: Buffer): StatusMessage | null {
    if (msg.length < LEGACY_STATUS_LENGTH) return null;

    const id     = readStr(msg, 16, 32);
    const status = msg[125] !== 0;   // byte 125 is the status flag in real responses
    // Fallback: some firmware puts status at offset 121
    const altStatus = msg[121] !== 0;

    return { id, status: status || altStatus };
}

/**
 * Parse a 130-byte full status response into a complete status object,
 * matching the legacy binary-parser layout.
 */
export function parseFullStatusResponse(msg: Buffer): StatusMessage | null {
    if (msg.length < LEGACY_STATUS_LENGTH) return null;
    // command1 at 0-5, model at 6-9, version at 10-15, id at 16-47,
    // name at 48-79, shortid at 80-111, unknown1 at 112-123, unsure at 124-128, status at 129
    const id     = readStr(msg, 16, 32);
    const status = msg[129] !== 0;
    return { id, status };
}

/**
 * Parse a 408-byte discovery response into a DeviceInfo record.
 */
export function parseDiscoveryResponse(msg: Buffer, remoteHost: string): DeviceInfo | null {
    if (msg.length < LEGACY_DISCOVERY_LENGTH) return null;

    try {
        // Offsets from reverse-engineered binary-parser layout in original eco.js
        const version  = readStr(msg, 4,   6);
        const id       = readStr(msg, 10,  32);
        const name     = readStr(msg, 42,  32) || id;
        const shortid  = readStr(msg, 74,  32);
        const SSID     = readStr(msg, 120, 24);
        const mac      = readStr(msg, 322, 18);
        let   host     = readStr(msg, 340, 18);  // IP stored in packet

        // Prefer the remote host if it's a private address
        host = sanitizeHost(remoteHost, host);

        void shortid; void SSID; void mac;

        // The discovery reply advertises the UDP command port at byte 404.
        // Most legacy devices use 80, but using the advertised value lets us
        // control firmware variants that chose a different port.
        const advertisedPort = msg.readUInt32LE(404);

        return {
            id:       id   || `LEGACY-${remoteHost}`,
            name,
            host,
            port:     advertisedPort >= 1 && advertisedPort <= 65535
                ? advertisedPort
                : LEGACY_DEFAULT_PORT,
            protocol: 'legacy',
            version,
        };
    } catch {
        return null;
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isPrivateAddress(address: string): boolean {
    if (!address || typeof address !== 'string') return false;
    if (address === 'localhost' || address === '127.0.0.1') return true;
    const octets = address.split('.').map(Number);
    if (octets.length !== 4 || octets.some(isNaN)) return false;
    return octets[0] === 10 ||
        (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
        (octets[0] === 192 && octets[1] === 168) ||
        (octets[0] === 169 && octets[1] === 254);
}

function sanitizeHost(remoteHost: string, fallbackHost: string): string {
    if (isPrivateAddress(remoteHost))  return remoteHost;
    if (isPrivateAddress(fallbackHost)) return fallbackHost;
    return remoteHost || fallbackHost;
}
