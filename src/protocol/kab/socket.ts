import * as dgram from 'dgram';
import { KAB_COMMAND_PORT } from '../../settings.js';

/** Repeat an identical bind-failure warning at most this often. */
const BIND_FAILURE_REPEAT_MS = 5 * 60 * 1000;

interface PendingRequest {
    resolve: (data: Buffer) => void;
    reject: (err: Error) => void;
}

interface PendingGroup {
    reqs: PendingRequest[];
    timer: NodeJS.Timeout;
    /** Optional validation function called for every incoming packet before
     * resolving the group.  If it returns false the message is ignored and the
     * group remains pending. */
    filter?: (msg: Buffer, rinfo: dgram.RemoteInfo) => boolean;
}

class KabSocketManager {
    private socket: dgram.Socket | null = null;
    private bindingData: Promise<void> | null = null;
    private currentError: Error | null = null;

    /** Port to bind the socket to; defaults to KAB_COMMAND_PORT but can be
     * overridden via configuration.  Setting to 0 tells the OS to choose an
     * ephemeral port. */
    private bindPort: number = KAB_COMMAND_PORT;

    /** Local address to bind the socket to. Undefined means the OS chooses
     * (wildcard bind), which is ambiguous on multi-homed hosts where more
     * than one interface shares a subnet with the target devices — the OS
     * may then route sends out whichever interface it resolves at send
     * time, including a stale/disassociated one, causing intermittent
     * EHOSTUNREACH. Set explicitly to pin all KAB traffic to one interface. */
    private bindAddress: string | undefined = undefined;

    /** Override the source port used for KAB commands.  Call before sending
     * any commands (e.g. from platform initialization).  If a socket is
     * already bound we tear it down so the next call to getSocket() will bind
     * again to the new port. */
    public setBindPort(port: number) {
        if (port === this.bindPort) return;
        this.bindPort = port;
        this.resetSocket();
    }

    /** Override the local address used for KAB commands. Call before sending
     * any commands (e.g. from platform initialization).  If a socket is
     * already bound we tear it down so the next call to getSocket() will bind
     * again to the new address. */
    public setBindAddress(address: string | undefined) {
        if (address === this.bindAddress) return;
        this.bindAddress = address;
        this.resetSocket();
    }

    /** Incremented whenever the bind settings change, so a bind that was already in
     * progress with the old settings is discarded instead of being used. */
    private generation = 0;

    /** Drop the current socket after a settings change; the next send binds a new one. */
    private resetSocket() {
        this.generation += 1;
        // A bind still in progress is kept: it notices the new generation and binds again
        // with the new settings, so concurrent callers never start a second bind.
        if (this.socket) {
            try { this.socket.close(); } catch {
                // ignore errors when closing the socket; nothing we can do here
            }
            this.socket = null;
            this.bindingData = null;
        }
        // replies to requests sent from the old socket can no longer arrive; fail them now
        // (callers retry) rather than letting each one wait for its full timeout
        const err = new Error('KAB socket was re-bound with new settings');
        for (const grp of this.pendingGroups.values()) {
            clearTimeout(grp.timer);
            for (const req of grp.reqs) req.reject(err);
        }
        this.pendingGroups.clear();
        this.pendingQueue.clear();
    }

    /**
     * Read‑only accessor for the currently configured bind port.  Used by
     * callers that need to temporarily switch to an ephemeral port then restore
     * the original value.
     */
    public getBindPort(): number {
        return this.bindPort;
    }

    // pendingGroups maps a unique group key (host:port:bufHex) to all callers
    // that piggybacked that exact outgoing buffer.  pendingQueue preserves
    // send order per-host so responses are demultiplexed FIFO.
    private pendingGroups = new Map<string, PendingGroup>();
    private pendingQueue  = new Map<string, string[]>(); // host -> [groupKey,...]

    private logFn?: (msg: string) => void;
    private errorFn?: (msg: string) => void;

    public setLogger(log: (msg: string) => void) {
        this.logFn = log;
    }

    /** Logger for problems the user needs to see (e.g. the socket cannot bind).
     * Falls back to the regular (debug) logger when not set. */
    public setErrorLogger(log: (msg: string) => void) {
        this.errorFn = log;
    }

    private log(msg: string) {
        if (this.logFn) this.logFn(msg);
    }

    private logError(msg: string) {
        if (this.errorFn) this.errorFn(msg);
        else this.log(msg);
    }

    /** Last bind failure reported at warn level, used to avoid repeating it on every
     * command/beacon ACK while the problem persists. */
    private lastBindFailure: { msg: string; at: number } | null = null;

    private reportBindFailure(msg: string) {
        const now = Date.now();
        const last = this.lastBindFailure;
        if (!last || last.msg !== msg || now - last.at > BIND_FAILURE_REPEAT_MS) {
            this.logError(msg);
            this.lastBindFailure = { msg, at: now };
        } else {
            this.log(msg); // repeated: debug only
        }
    }

    private async getSocket(): Promise<dgram.Socket> {
        if (this.socket) { // check if already bound
            return this.socket;
        }

        if (!this.bindingData) {
            this.bindingData = this.bindSocket().catch((err: Error) => {
                this.currentError = err;
                this.reportBindFailure(`KAB socket could not bind to ${this.bindAddress ?? '0.0.0.0'}:${this.bindPort}: ${err.message}`);
                throw err;
            });
        }

        const binding = this.bindingData;
        try {
            await binding;
        } catch (err) {
            // forget the failed attempt so the next call tries to bind again
            if (this.bindingData === binding) this.bindingData = null;
            throw err;
        }
        return this.socket!;
    }

    /** Bind the shared socket, retrying without SO_REUSEPORT if the platform lacks it. */
    private async bindSocket(): Promise<void> {
        const generation = this.generation;
        let sock: dgram.Socket;
        try {
            // use SO_REUSEADDR and SO_REUSEPORT so multiple processes (e.g. diag,
            // another instance) can listen on the same port simultaneously.  On
            // Linux SO_REUSEPORT gives each socket its own queue but both will
            // receive copies of incoming datagrams.
            sock = await this.openSocket(true);
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOTSUP') {
                throw err;
            }
            // macOS (and any other platform where libuv has no SO_REUSEPORT support)
            // raises ENOTSUP when the option is requested; retry with SO_REUSEADDR only.
            this.log('SO_REUSEPORT is not supported on this platform; binding without it');
            sock = await this.openSocket(false);
        }
        if (generation !== this.generation) {
            // the port/address changed while this bind was in progress: bind again with the new settings
            try { sock.close(); } catch {
                // ignore errors when closing the socket; nothing we can do here
            }
            return this.bindSocket();
        }
        this.socket = sock;
        this.socket.unref(); // don't block node from exiting
        this.currentError = null;
        this.lastBindFailure = null; // a later failure should be reported again
        const addr = this.socket.address();
        this.log(`KAB global socket bound to ${addr.address}:${addr.port}`);
    }

    /** Create a UDP socket and bind it; rejects if the bind itself fails. */
    private openSocket(reusePort: boolean): Promise<dgram.Socket> {
        return new Promise((resolve, reject) => {
            const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true, reusePort });
            let bound = false;

            sock.on('error', (err) => {
                if (!bound) {
                    // bind-time failure: report it to the caller instead of leaving it waiting forever
                    try { sock.close(); } catch {
                        // ignore errors when closing a socket that never bound
                    }
                    reject(err);
                    return;
                }
                this.log(`KAB global socket error: ${err.message}`);
                this.currentError = err;
                this.socket = null;
                this.bindingData = null;
                // Reject all pending groups
                for (const grp of this.pendingGroups.values()) {
                    clearTimeout(grp.timer);
                    for (const req of grp.reqs) req.reject(err);
                }
                this.pendingGroups.clear();
                this.pendingQueue.clear();
            });

            sock.on('message', (msg, rinfo) => {
                this.log(`KAB rx ${msg.length}B from ${rinfo.address}:${rinfo.port}: ${msg.toString('hex')}`);
                const host = rinfo.address;
                const queue = this.pendingQueue.get(host);
                if (!queue || queue.length === 0) {
                    this.log(`KAB rx dropped: No pending requests for ${host}`);
                    return;
                }

                // walk the queue looking for a group whose filter (if any) accepts
                // this message.  keep the first matching entry in FIFO order.
                for (let idx = 0; idx < queue.length; idx++) {
                    const groupKey = queue[idx];
                    const group = this.pendingGroups.get(groupKey);
                    if (!group) continue;
                    if (group.filter) {
                        if (group.filter === undefined) {
                            // shouldn't happen
                        } else if (!group.filter(msg, rinfo)) {
                            // log reason if filter rejected self-echo
                            if (msg.equals(Buffer.from(groupKey.split(':')[2], 'hex'))) {
                                this.log('KAB rx filtered: self echo');
                            } else {
                                this.log('KAB rx filtered: predicate denied');
                            }
                            continue; // not for this group
                        }
                    }
                    // match: remove the key from queue and resolve
                    queue.splice(idx, 1);
                    clearTimeout(group.timer);
                    for (const req of group.reqs) {
                        req.resolve(msg);
                    }
                    this.pendingGroups.delete(groupKey);
                    return;
                }

                this.log('KAB rx dropped: no group accepted the packet');
            });

            const onBound = () => {
                bound = true;
                resolve(sock);
            };

            if (this.bindAddress) {
                sock.bind(this.bindPort, this.bindAddress, onBound);
            } else {
                sock.bind(this.bindPort, onBound);
            }
        });
    }

    public async sendAndReceive(
        buf: Buffer,
        host: string,
        port: number,
        timeoutMs: number,
        filter?: (msg: Buffer, rinfo: dgram.RemoteInfo) => boolean,
    ): Promise<Buffer> {
        const sock = await this.getSocket();
        return new Promise((resolve, reject) => {
            const bufHex = buf.toString('hex');
            const groupKey = `${host}:${port}:${bufHex}`;

            const req: PendingRequest = { resolve, reject };

            // If a group for this identical buf is already pending, piggyback (and
            // inherit its filter if one exists).
            const existing = this.pendingGroups.get(groupKey);
            if (existing) {
                existing.reqs.push(req);
                return;
            }

            // Create a new group and enqueue it for this host.
            const timer = setTimeout(() => {
                // timeout: reject all in group and cleanup
                const grp = this.pendingGroups.get(groupKey);
                if (grp) {
                    for (const r of grp.reqs) {
                        r.reject(new Error(`KAB command timeout after ${timeoutMs}ms for ${host}:${port}`));
                    }
                    this.pendingGroups.delete(groupKey);
                }
                const q = this.pendingQueue.get(host);
                if (q) {
                    const idx = q.indexOf(groupKey);
                    if (idx !== -1) q.splice(idx, 1);
                }
            }, timeoutMs);

            this.pendingGroups.set(groupKey, { reqs: [req], timer, filter });
            if (!this.pendingQueue.has(host)) this.pendingQueue.set(host, []);
            this.pendingQueue.get(host)!.push(groupKey);

            // attempt to decode cmdCode/subtype/payload for clarity
            let desc = '';
            try {
                if (buf.length >= 84) {
                    const code = buf.readUInt32LE(4);
                    const subtype = buf.readUInt32LE(76);
                    const payload = buf.readUInt32LE(80);
                    if (code === 22 && subtype === 106) {
                        desc = 'STATUS_QUERY'; // payload ignored
                    } else if (code === 23 && subtype === 106) {
                        desc = payload === 1 ? 'POWER_ON' : 'POWER_OFF';
                    } else {
                        desc = `cmd=${code} sub=${subtype} p=${payload}`;
                    }
                }
            } catch {
                // ignore malformed buffers; logging happens below regardless
            }
            this.log(`KAB tx ${buf.length}B to ${host}:${port}${desc ? ' ['+desc+']' : ''}: ${bufHex}`);
            sock.send(buf, 0, buf.length, port, host, (err) => {
                if (err) {
                    const grp = this.pendingGroups.get(groupKey);
                    if (grp) {
                        clearTimeout(grp.timer);
                        for (const r of grp.reqs) r.reject(err);
                        this.pendingGroups.delete(groupKey);
                    }
                    const q = this.pendingQueue.get(host);
                    if (q) {
                        const idx = q.indexOf(groupKey);
                        if (idx !== -1) q.splice(idx, 1);
                    }
                }
            });
        });
    }

    public async send(buf: Buffer, host: string, port: number): Promise<void> {
        const sock = await this.getSocket();
        return new Promise((resolve, reject) => {
            sock.send(buf, 0, buf.length, port, host, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    }
}

export const kabSocket = new KabSocketManager();
