/**
 * Plugin settings, constants and configuration interface.
 */

export const PLUGIN_NAME    = '@homebridge-plugins/homebridge-ecoplugs';
export const PLATFORM_NAME  = 'EcoPlug';

/** UDP port Homebridge listens on for legacy device status/ack messages. */
export const DEFAULT_INCOMING_PORT    = 9000;
/** Broadcast interval in seconds. */
export const DEFAULT_DISCOVER_INTERVAL  = 60;
/** Status poll interval in seconds. */
export const DEFAULT_POLLING_INTERVAL   = 10;
/** Mark accessory inactive after X seconds without response (0 = never). */
export const DEFAULT_DEVICE_INACTIVE_TIMEOUT = DEFAULT_DISCOVER_INTERVAL * 3;
/** Remove accessory after X seconds without response (0 = never). */
export const DEFAULT_DEVICE_REMOVE_TIMEOUT = 0;

/** Legacy broadcast discovery port (FtNetManager). */
export const LEGACY_DISCOVERY_PORT  = 25;
/** Secondary legacy discovery port. */
export const LEGACY_DISCOVERY_PORT2 = 5888;
/** KABNetManager device beacon broadcast port. */
export const KAB_BEACON_PORT        = 10228;
/** KABNetManager command SOURCE port — we bind here so the device registers us at IP:9090. */
export const KAB_COMMAND_PORT       = 9090;  // default source port used for KAB commands
/** KABNetManager command DESTINATION port — the device listens here for incoming commands. */
export const KAB_DEVICE_PORT        = 1022;
/** KABNetManager fallback command port A. */
export const KAB_COMMAND_PORT_B     = 6000;
/** KABNetManager fallback command port B (legacy). */
export const KAB_COMMAND_PORT_C     = 80;
/** Legacy (FtNetManager) command/status port — same value as KAB_COMMAND_PORT_C
 * but named for its own protocol so static-IP legacy device config doesn't
 * accidentally default to a KAB-specific constant. */
export const LEGACY_DEFAULT_PORT    = 80;

/** HomeKit service for newly added devices when `defaultServiceType` is not set
 * (matches the default shown in the Homebridge config UI). */
export const DEFAULT_SERVICE_TYPE: 'outlet' | 'switch' = 'switch';

export const DEFAULT_LOCAL_ONLY    = true;
export const DEFAULT_ENABLED       = true;
/** How long to wait for a response to a KAB command (ms). */
export const DEFAULT_KAB_COMMAND_TIMEOUT_MS = 4000;

/** Per‑device protocol preference. */
export type ProtocolPreference = 'auto' | 'legacy' | 'kab';

/**
 * Shape of a single device override entry in the Homebridge configuration.
 */
export interface DeviceConfig {
    /** Device ID string, e.g. "ECO-78ABCDEF". */
    id: string;
    /**
     * Type of HomeKit service to expose for this device.  If omitted the
     * platform-wide `defaultServiceType` (or the built-in outlet) is used.
     * Valid values are `'outlet'` and `'switch'`.
     */
    serviceType?: 'outlet' | 'switch';
    /**
     * Static IP address of the device.
     * When set, the platform will seed this device on startup without
     * waiting for a beacon on port 10228.  The kabKey/kabPass will be
     * applied immediately; if not set, the defaults are used and will be
     * updated as soon as a beacon is received from the device.
     */
    host?: string;
    /**
     * Port to send commands to on the device.  Used whenever set, except 9090 on a KAB device,
     * which is ignored; otherwise the port the device advertises (fallback: 1022 for KAB, 80
     * for legacy).
     */
    commandPort?: number;
    /** Override credential/key from beacon (default: auto from beacon). */
    kabKey?: string;
    /** Override password for KAB commands (default: "111111"). */
    kabPass?: string;
    /** Force a specific protocol (default: "auto"). */
    protocol?: ProtocolPreference;
    /** Per-device flag to suppress beacon ACK packet */
    kabSkipBeaconAck?: boolean;
}

/**
 * Shape of the full Homebridge platform configuration block.
 */
export interface EcoPlugConfig {
    platform: string;
    name: string;
    enabled?: boolean;
    localOnly?: boolean;
    port?: number;
    pollingInterval?: number;
    discoverInterval?: number;
    deviceInactiveTimeout?: number;
    deviceRemoveTimeout?: number;
    /** Per‑device overrides. */
    devices?: DeviceConfig[];
    /** Bind port for outgoing KAB commands (0 for ephemeral). */
    kabBindPort?: number;
    /**
     * Local IPv4 address to bind the KAB command socket and the legacy socket to.
     * Leave unset for the default wildcard bind. Useful on multi-homed hosts
     * where a wildcard bind can cause the OS to intermittently route traffic
     * out the wrong (or a stale/disconnected) interface, producing
     * EHOSTUNREACH errors.  The KAB beacon listener (port 10228) is never pinned
     * because beacons are broadcasts.
     */
    bindAddress?: string;
    /** Suppress the beacon acknowledgment packet.  Useful for buggy devices. */
    kabSkipBeaconAck?: boolean;    /**
     * Default service type to use when creating accessories.  Individual
     * devices may override this via `devices[].serviceType`.
     * Accepted values are `'outlet'` (the historical default) and `'switch'`.
     */
    defaultServiceType?: 'outlet' | 'switch';    // NOTE: beacon-driven status updates are now always enabled.  The
    // previous `enableBeaconUpdates` configuration option has been removed
    // in favour of always listening to the KAB beacons and reacting to them.
    /** Enable verbose debug logging even when Homebridge log level is not debug */
    debug?: boolean;
}
