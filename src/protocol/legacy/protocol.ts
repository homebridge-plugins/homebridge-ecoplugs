/**
 * Legacy FtNetManager command flow: discovery + send/receive on a shared socket.
 */

import * as dgram from 'dgram';
import * as os from 'os';
import {
    buildGetRequest,
    buildSetRequest,
    buildDiscoveryProbe,
    parseDiscoveryResponse,
    parseFullStatusResponse,
    LEGACY_DISCOVERY_LENGTH,
    LEGACY_ACK_LENGTH,
    LEGACY_STATUS_LENGTH,
} from './packets.js';
import {
    LEGACY_DISCOVERY_PORT,
    LEGACY_DISCOVERY_PORT2,
} from '../../settings.js';
import type { DeviceInfo, StatusMessage } from '../types.js';

/** Limited broadcast, always probed; directed (per-subnet) broadcasts are added to it. */
const LIMITED_BROADCAST    = '255.255.255.255';
const DISCOVERY_TIMEOUT_MS = 1500;
const COMMAND_TIMEOUT_MS   = 500;
const DEFAULT_RETRIES      = 3;

export type StatusCallback = (msg: StatusMessage) => void;

export interface LegacyManager {
    /** Send a power set command. */
    setPower(device: DeviceInfo, on: boolean): void;
    /** Send a status poll request. */
    getStatus(device: DeviceInfo): void;
    /**
     * Trigger a discovery broadcast; resolves with found devices.
     *
     * `unicastHosts` are known device addresses (static-IP devices from the
     * config) that are probed directly as well, so they are found even when
     * broadcasts do not reach them.
     */
    discover(unicastHosts?: readonly string[]): Promise<DeviceInfo[]>;
    /** Start background status listener; `callback` called on each status message. */
    startStatusListener(callback: StatusCallback): void;
    /** Shut down the socket. */
    close(): void;
}

/**
 * Create a legacy protocol manager.  Call `startStatusListener` first to bind
 * the incoming port, then `discover` to populate your device list.
 *
 * @param incomingPort  UDP port Homebridge listens on for device messages.
 * @param localOnly     When true, silently ignore messages from public IPs.
 * @param log           Optional logger.
 * @param bindAddress   Optional local address to bind the socket to. Leave
 *                       undefined for the default wildcard bind. On
 *                       multi-homed hosts (e.g. a Mac with both Ethernet and
 *                       Wi-Fi live on the same subnet) a wildcard bind lets
 *                       the OS pick the outgoing interface per-send, which
 *                       can intermittently route broadcast/unicast traffic
 *                       out a stale or disconnected interface and fail with
 *                       EHOSTUNREACH. Pin to a specific interface address to
 *                       avoid that.
 */
export function createLegacyManager(
    incomingPort: number,
    localOnly: boolean,
    log?: (msg: string) => void,
    bindAddress?: string,
): LegacyManager {
    const socket = dgram.createSocket('udp4');
    let statusCallback: StatusCallback | null = null;
    let bound = false;
    let bindingPromise: Promise<void> | null = null;

    // Map of partial discoveries keyed by sequence number or device ID
    const discoveredMap = new Map<string, DeviceInfo>();

    socket.on('error', (err) => {
        log?.(`Legacy socket error: ${err.message}`);
    });

    socket.on('message', (raw: Buffer, remote: dgram.RemoteInfo) => {
        if (localOnly && !isPrivateAddress(remote.address)) return;

        try {
            if (raw.length >= LEGACY_DISCOVERY_LENGTH) {
                const device = parseDiscoveryResponse(
                    raw.subarray(0, LEGACY_DISCOVERY_LENGTH),
                    remote.address,
                );
                if (device) {
                    discoveredMap.set(device.id, device);
                }
                return;
            }

            if (raw.length >= LEGACY_STATUS_LENGTH) {
                const msg = parseFullStatusResponse(
                    raw.subarray(0, LEGACY_STATUS_LENGTH),
                );
                if (msg && statusCallback) {
                    statusCallback(msg);
                }
                return;
            }

            if (raw.length >= LEGACY_ACK_LENGTH) {
                // ACK — no action needed (setPower confirmation handled by timeout)
                return;
            }
        } catch (e) {
            log?.(`Legacy message parse error: ${(e as Error).message}`);
        }
    });

    function ensureBound(port: number): Promise<void> {
        if (bound) {
            return Promise.resolve();
        }

        if (bindingPromise) {
            return bindingPromise;
        }

        const attemptPromise = new Promise<void>((resolve, reject) => {
            const onError = (err: Error) => {
                socket.off('listening', onListening);
                bindingPromise = null;
                reject(err);
            };

            const onListening = () => {
                socket.off('error', onError);
                socket.setBroadcast(true);
                bound = true;
                bindingPromise = null;
                log?.(`Legacy socket bound to port ${port}`);
                resolve();
            };

            socket.once('error', onError);
            socket.once('listening', onListening);
            try {
                if (bindAddress) {
                    socket.bind(port, bindAddress);
                } else {
                    socket.bind(port);
                }
            } catch (err) {
                // bind() can also throw synchronously (e.g. ERR_SOCKET_ALREADY_BOUND)
                socket.off('error', onError);
                socket.off('listening', onListening);
                reject(err as Error);
            }
        });

        bindingPromise = attemptPromise;
        // forget a failed attempt so the next call retries instead of reusing the rejection
        attemptPromise.catch(() => {
            if (bindingPromise === attemptPromise) bindingPromise = null;
        });
        return attemptPromise;
    }

    function sendToDevice(
        buf: Buffer,
        device: DeviceInfo,
        retries = DEFAULT_RETRIES,
        callback?: (err?: Error) => void,
    ): void {
        if (localOnly && !isPrivateAddress(device.host)) {
            callback?.(new Error(`Refusing to send to non-local host ${device.host}`));
            return;
        }
        const attempt = (remaining: number) => {
            socket.send(buf, 0, buf.length, device.port, device.host, (err) => {
                if (err) {
                    if (remaining > 1) {
                        setTimeout(() => attempt(remaining - 1), COMMAND_TIMEOUT_MS);
                    } else {
                        // sends are fire-and-forget, so without this a failure (e.g. EHOSTUNREACH)
                        // would leave no trace at all
                        log?.(`Legacy send to ${device.host}:${device.port} failed after ${retries} attempt(s): ${err.message}`);
                        callback?.(err);
                    }
                }
            });
        };
        // Never send from an unbound socket: Node would implicitly bind it to 0.0.0.0 on a
        // random port, which bypasses bindAddress and makes the incoming port impossible to
        // bind afterwards (every later bind fails with "Socket is already bound").
        ensureBound(incomingPort).then(
            () => attempt(retries),
            (err: Error) => {
                log?.(`Legacy send to ${device.host}:${device.port} skipped, socket is not bound: ${err.message}`);
                callback?.(err);
            },
        );
    }

    function sendDiscoveryProbe(
        host: string,
        port: number,
        retries: number,
        callback: (err?: Error) => void,
    ): void {
        const probe = buildDiscoveryProbe();
        const attempt = (remaining: number) => {
            socket.send(probe, 0, 128, port, host, (err) => {
                if (err) {
                    log?.(`Legacy discovery probe to ${host}:${port} failed: ${err.message}`);
                    callback(err);
                } else if (remaining > 1) {
                    setTimeout(() => attempt(remaining - 1), DISCOVERY_TIMEOUT_MS);
                } else {
                    setTimeout(() => callback(), DISCOVERY_TIMEOUT_MS);
                }
            });
        };
        attempt(retries);
    }

    return {
        startStatusListener(callback: StatusCallback): void {
            statusCallback = callback;
            ensureBound(incomingPort).catch((e) =>
                log?.(`Failed to bind legacy socket: ${(e as Error).message}`),
            );
        },

        discover(unicastHosts: readonly string[] = []): Promise<DeviceInfo[]> {
            discoveredMap.clear();
            return ensureBound(incomingPort).then(
                () =>
                    new Promise((resolve) => {
                        // Listing interfaces can throw on restricted systems. The extra broadcasts
                        // are an addition, so never let that stop the plain broadcast from working.
                        let interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = {};
                        try {
                            interfaces = os.networkInterfaces();
                        } catch (err) {
                            log?.(
                                'Legacy discovery: cannot list network interfaces, ' +
                                `probing ${LIMITED_BROADCAST} only: ${(err as Error).message}`,
                            );
                        }
                        const hosts = [
                            ...discoveryBroadcastTargets(interfaces, { bindAddress, localOnly }),
                            ...unicastProbeHosts(unicastHosts, localOnly, log),
                        ];
                        const probes: Array<{ host: string; port: number }> = [];
                        for (const host of new Set(hosts)) {
                            probes.push({ host, port: LEGACY_DISCOVERY_PORT });
                            probes.push({ host, port: LEGACY_DISCOVERY_PORT2 });
                        }

                        let remaining = probes.length;
                        const done = () => {
                            remaining--;
                            if (remaining === 0) {
                                resolve([...discoveredMap.values()]);
                            }
                        };
                        for (const probe of probes) {
                            sendDiscoveryProbe(probe.host, probe.port, 3, done);
                        }
                    }),
            );
        },

        setPower(device: DeviceInfo, on: boolean): void {
            sendToDevice(buildSetRequest(device.id, on), device);
        },

        getStatus(device: DeviceInfo): void {
            sendToDevice(buildGetRequest(device.id), device);
        },

        close(): void {
            try { socket.close(); } catch { /* ignore */ }
        },
    };
}

// ── Discovery targets ─────────────────────────────────────────────────────────

function ipv4ToInt(address: string): number | null {
    const parts = address.split('.');
    if (parts.length !== 4) return null;
    let value = 0;
    for (const part of parts) {
        if (!/^\d{1,3}$/.test(part) || Number(part) > 255) return null;
        value = value * 256 + Number(part);
    }
    return value;
}

function intToIpv4(value: number): string {
    return [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join('.');
}

/**
 * The directed broadcast address of an IPv4 interface (e.g. 192.168.1.255 for
 * 192.168.1.20/24), or null when the interface has none: a /31 or /32, or an
 * address or netmask that is not valid.
 */
export function directedBroadcastAddress(address: string, netmask: string): string | null {
    const addr = ipv4ToInt(address);
    const mask = ipv4ToInt(netmask);
    if (addr === null || mask === null || mask === 0) return null;
    const hostBits = (~mask) >>> 0;
    // the mask must be contiguous ones followed by zeros, with at least 2 host bits
    if ((hostBits & (hostBits + 1)) !== 0 || hostBits < 3) return null;
    return intToIpv4((addr | hostBits) >>> 0);
}

/**
 * The broadcast addresses to send discovery probes to.
 *
 * The limited broadcast (255.255.255.255) is always included, as before. Each
 * usable IPv4 interface also contributes its own subnet's directed broadcast,
 * which the OS reliably sends out of that interface. This is what the official
 * ECO Plugs setup tools do, and it finds devices when the limited broadcast
 * leaves through a different interface.
 *
 * With `bindAddress` set, only that interface's broadcast is added: a socket
 * pinned to one address must not probe other subnets. With `localOnly`, only
 * private subnets are probed.
 */
export function discoveryBroadcastTargets(
    interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>,
    options: { bindAddress?: string; localOnly: boolean },
): string[] {
    const targets: string[] = [LIMITED_BROADCAST];
    const pinned = options.bindAddress && options.bindAddress !== '0.0.0.0'
        ? options.bindAddress
        : undefined;

    for (const addresses of Object.values(interfaces)) {
        for (const info of addresses ?? []) {
            if (info.family !== 'IPv4' || info.internal) continue;
            if (pinned && info.address !== pinned) continue;
            const broadcast = directedBroadcastAddress(info.address, info.netmask);
            if (!broadcast || targets.includes(broadcast)) continue;
            if (options.localOnly && !isPrivateAddress(broadcast)) continue;
            targets.push(broadcast);
        }
    }
    return targets;
}

/** Known device addresses that may be probed directly (IPv4 literals, and only local ones with `localOnly`). */
function unicastProbeHosts(
    hosts: readonly string[],
    localOnly: boolean,
    log?: (msg: string) => void,
): string[] {
    const usable: string[] = [];
    for (const host of hosts) {
        if (ipv4ToInt(host) === null) {
            log?.(`Legacy discovery: not probing "${host}" directly, it is not an IPv4 address`);
        } else if (localOnly && !isPrivateAddress(host)) {
            log?.(`Legacy discovery: not probing non-local host ${host}`);
        } else if (!usable.includes(host)) {
            usable.push(host);
        }
    }
    return usable;
}

// ── Utilities ─────────────────────────────────────────────────────────────────

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
