```typescript
/**
 * @file A lightweight, resilient Discord Gateway client that connects separately
 * from the main `discord.js` client and listens for INTERACTION_CREATE events.
 * Intended to be used only for interaction types you want to handle with
 * raw REST calls (e.g. modal submits that discord.js misparses).
 *
 * Usage:
 *  ```typescript
 *  const gw = new RawGateway(process.env.DISCORD_TOKEN!);
 *  gw.registerHandler(predicateFn, handlerFn);
 *  await gw.start();
 *  ```
 *
 * Handler contract:
 *  - predicate(d) => boolean | Promise<boolean>  // matches raw packet.d
 *  - handler(d) => Promise<void> | void          // receives raw packet.d
 *
 * Notes:
 *  - This connection identifies with intents: 0 (INTERACTION_CREATE is delivered).
 *  - The gateway implements heartbeat and exponential reconnect backoff.
 */

import WebSocket from 'ws';
import EventEmitter from 'events';

type Packet = {
  op: number;
  d?: any;
  s?: number | null;
  t?: string | null;
};

interface HandlerRegistration {
  predicate: (d: any) => boolean | Promise<boolean>;
  handler: (d: any) => Promise<void> | void;
}

/**
 * A focused gateway connection used to receive INTERACTION_CREATE events directly
 * from Discord and dispatch them to registered handlers. The class intentionally
 * keeps a small public surface: `registerHandler`, `start`, and `stop`.
 *
 * It is safe to construct multiple RawGateway instances, but only one is needed
 * for most use-cases.
 */
export class RawGateway extends EventEmitter {
  private token: string;
  private ws?: WebSocket;
  private readonly url = 'wss://gateway.discord.gg/?v=10&encoding=json';
  private seq: number | null = null;
  private heartbeatIntervalMs = 0;
  private hbTimer?: NodeJS.Timeout;
  private closedManually = false;
  private registrations: HandlerRegistration[] = [];
  private reconnectDelay = 1000;
  private readonly maxReconnectDelay = 60_000;
  private identifying = false;

  /**
   * Construct the RawGateway.
   * @param token - Bot token (must be a valid bot token)
   * @throws If token is falsy.
   */
  constructor(token: string) {
    super();
    if (!token) throw new Error('RawGateway requires a bot token');
    this.token = token;
  }

  /**
   * Register a handler for incoming INTERACTION_CREATE payloads.
   * The predicate is called with the raw `d` object and may be async.
   * If predicate returns truthy, the handler is called with the same `d`.
   *
   * @param predicate - synchronous or asynchronous predicate that receives raw packet.d
   * @param handler - synchronous or asynchronous handler invoked when predicate matches
   */
  registerHandler(
    predicate: HandlerRegistration['predicate'],
    handler: HandlerRegistration['handler']
  ) {
    this.registrations.push({ predicate, handler });
  }

  /**
   * Start the gateway connection. This method returns after the initial connect
   * sequence is made (it does not wait for subsequent reconnections).
   */
  async start() {
    this.closedManually = false;
    await this.connect();
  }

  /**
   * Stop the gateway gracefully.
   * Will close the websocket and stop heartbeating.
   */
  stop() {
    this.closedManually = true;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try { this.ws.close(1000, 'Client requested close'); } catch { /* ignore */ }
    }
    this.clearHeartbeat();
  }

  /**
   * Internal: create/connect the websocket and wire event listeners.
   */
  private async connect() {
    this.identifying = false;
    try {
      this.ws = new WebSocket(this.url);

      this.ws.on('open', () => {
        this.reconnectDelay = 1000;
        this.emit('open');
      });

      this.ws.on('message', (data: WebSocket.Data) => {
        try {
          const text = typeof data === 'string' ? data : data.toString();
          const pkt: Packet = JSON.parse(text);

          // Keep sequence
          if (pkt.s !== undefined && pkt.s !== null) this.seq = pkt.s;

          // Hello (OP 10)
          if (pkt.op === 10 && pkt.d) {
            this.handleHello(pkt.d);
            return;
          }

          // Only dispatch INTERACTION_CREATE (t === 'INTERACTION_CREATE')
          if (pkt.t === 'INTERACTION_CREATE' && pkt.d) {
            // handle async but do not await to avoid blocking the ws message loop
            this.handleInteractionCreate(pkt.d).catch(err => {
              console.error('[RawGateway] handler error', err);
            });
            return;
          }

          // emit other packets for debugging if caller wants to listen
          this.emit('packet', pkt);
        } catch (err) {
          console.error('[RawGateway] message parse error', err);
        }
      });

      this.ws.on('close', (code, reason) => {
        this.clearHeartbeat();
        this.emit('close', code, reason?.toString());
        if (!this.closedManually) {
          console.warn(`[RawGateway] closed (code=${code}) reconnecting in ${this.reconnectDelay}ms`);
          setTimeout(() => this.connect().catch(console.error), this.reconnectDelay);
          this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
        }
      });

      this.ws.on('error', (err) => {
        this.emit('error', err);
        console.error('[RawGateway] ws error', err);
      });
    } catch (err) {
      console.error('[RawGateway] connect failed', err);
      setTimeout(() => this.connect().catch(console.error), this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
    }
  }

  /**
   * Handle the gateway 'HELLO' payload (starts heartbeating and identifies).
   * @param d - payload.d from OP 10
   */
  private handleHello(d: any) {
    if (d && d.heartbeat_interval) {
      this.heartbeatIntervalMs = d.heartbeat_interval;
      this.startHeartbeat();
    }
    this.identify();
  }

  /**
   * Start the heartbeat timer (OP 1).
   */
  private startHeartbeat() {
    this.clearHeartbeat();
    if (!this.heartbeatIntervalMs) return;
    // send an immediate heartbeat then schedule
    this.sendHeartbeat();
    this.hbTimer = setInterval(() => this.sendHeartbeat(), this.heartbeatIntervalMs);
  }

  /**
   * Clear the heartbeat timer.
   */
  private clearHeartbeat() {
    if (this.hbTimer) {
      clearInterval(this.hbTimer);
      this.hbTimer = undefined;
    }
  }

  /**
   * Send an OP 1 heartbeat using the last seen sequence.
   */
  private sendHeartbeat() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const payload = { op: 1, d: this.seq ?? null };
    try {
      this.ws.send(JSON.stringify(payload));
    } catch (err) {
      console.error('[RawGateway] heartbeat send failed', err);
    }
  }

  /**
   * Identify with the gateway. We set intents: 0 because we only need to receive
   * INTERACTION_CREATE dispatches.
   */
  private identify() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this.identifying) return;
    this.identifying = true;
    const identifyPayload = {
      op: 2,
      d: {
        token: this.token,
        intents: 0,
        properties: {
          $os: process.platform,
          $browser: 'raw-gateway',
          $device: 'raw-gateway'
        }
      }
    };
    try {
      this.ws.send(JSON.stringify(identifyPayload));
      this.emit('identify');
      setTimeout(() => { this.identifying = false; }, 1000);
    } catch (err) {
      console.error('[RawGateway] identify failed', err);
      this.identifying = false;
    }
  }

  /**
   * Internal: called when an INTERACTION_CREATE dispatch is received.
   * Iterates registered handlers and invokes handlers whose predicate matches.
   * @param d - raw packet.d for INTERACTION_CREATE
   */
  private async handleInteractionCreate(d: any) {
    try {
      for (const reg of this.registrations) {
        let match = false;
        try {
          match = await Promise.resolve(reg.predicate(d));
        } catch (err) {
          console.error('[RawGateway] predicate error', err);
        }
        if (match) {
          try {
            await Promise.resolve(reg.handler(d));
          } catch (err) {
            console.error('[RawGateway] handler threw', err);
          }
        }
      }
    } catch (err) {
      console.error('[RawGateway] handleInteractionCreate failed', err);
    }
  }
}

export default RawGateway;
```