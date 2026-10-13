/**
 * VerixOS - the live desktop host.
 *
 * A local HTTP server that streams the machine's frame buffer to a browser window
 * and takes input back, so the desktop is something a person can *use* rather than
 * a directory of PNGs.
 *
 * ## Why a browser and not a native window
 *
 * A native window needs a GUI toolkit: a native dependency, a build step, and a
 * different set of three per platform. This project's commitments are zero runtime
 * dependencies and "clone it and run it", and a browser is the one window system
 * already installed everywhere the project claims to support, already handling
 * scaling and DPI. It is also how the serious emulator projects do it, for the
 * same reasons.
 *
 * ## Why the frame buffer goes out as palette indices
 *
 * The adapter holds 64 000 palette indices, not 256 000 RGB triples. Sending what
 * the adapter actually holds makes the wire six times smaller and the client's
 * work a table lookup instead of three channel extractions. At 30 frames a second
 * that is 1.9 MB/s of payload rather than 7.7 MB/s - the difference between
 * "works over Wi-Fi" and "works on a USB link" - and it means the host is never
 * the bottleneck.
 *
 * ## The protocol
 *
 * Three kinds of message, and nothing else:
 *
 * ```text
 *   server -> client   binary   the frame buffer, palette indices or RGB bytes
 *   server -> client   text     {"kind":"geometry","width":..,"height":..,"indexed":..}
 *   client -> server   text     {"t":"move"|"down"|"up"|"wheel"|"key"|"keyup"|"reset", ...}
 * ```
 *
 * A `geometry` message is sent whenever the screen's size or pixel format
 * changes - once when the boot console is replaced by the desktop, and not again.
 * Sending it per frame would triple the message count to say nothing.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Socket } from 'node:net';

import type { Kernel } from '../kernel/kernel.ts';
import { encodePng } from '../../tools/screenshot.ts';

const HERE = import.meta.dirname;

/** The magic from RFC 6455 that the handshake concatenates with the key. */
const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export interface DesktopHostOptions {
  readonly kernel: Kernel;
  /** Frames per second to present. */
  readonly fps?: number;
  /** How long the boot console is shown before the desktop takes the screen. */
  readonly bootHoldMs?: number;
  readonly host?: string;
  readonly port?: number;
}

export interface DesktopHost {
  readonly url: string;
  readonly port: number;
  /** Clients currently connected. */
  readonly clients: number;
  /** Present once and resolve when the server is listening. */
  listen(): Promise<void>;
  close(): Promise<void>;
  /** Show the captured boot console before the desktop takes over. */
  showBootConsole(): void;
  /** The most recent frame's cost. */
  readonly lastFrame: { written: number; examined: number } | undefined;
}

interface Geometry {
  readonly width: number;
  readonly height: number;
  /** True when the payload is one palette index per pixel. */
  readonly indexed: boolean;
}

/* -------------------------------------------------------------------------- */
/* WebSocket framing                                                           */
/* -------------------------------------------------------------------------- */

/** Build a single unmasked server-to-client frame. */
function encodeFrame(payload: Uint8Array, opcode = 0x02): Buffer {
  const length = payload.length;
  const header: number[] = [0x80 | opcode];
  if (length < 126) {
    header.push(length);
  } else if (length < 65_536) {
    header.push(126, (length >> 8) & 0xff, length & 0xff);
  } else {
    header.push(
      127,
      0,
      0,
      0,
      0,
      (length >>> 24) & 0xff,
      (length >>> 16) & 0xff,
      (length >>> 8) & 0xff,
      length & 0xff,
    );
  }
  return Buffer.concat([Buffer.from(header), Buffer.from(payload)]);
}

/**
 * Parse one client-to-server frame, unmasking its payload.
 *
 * Clients are required to mask, and applying the key is not optional: a server that
 * trusted the length byte without unmasking would read whatever the next bytes
 * happened to be, which is both a protocol violation and a way to make it
 * interpret an arbitrary payload as input.
 */
function decodeFrame(buffer: Buffer): { opcode: number; payload: Buffer; size: number } | undefined {
  if (buffer.length < 2) return undefined;
  const first = buffer[0]!;
  const second = buffer[1]!;
  const opcode = first & 0x0f;
  const masked = (second & 0x80) !== 0;
  let length = second & 0x7f;
  let offset = 2;

  if (length === 126) {
    if (buffer.length < offset + 2) return undefined;
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) return undefined;
    // The high 32 bits are deliberately not read. A frame that large is not one
    // this protocol sends, and trusting them would let a client claim a gigabyte.
    length = buffer.readUInt32BE(offset + 4);
    offset += 8;
  }

  let mask: Buffer | undefined;
  if (masked) {
    if (buffer.length < offset + 4) return undefined;
    mask = buffer.subarray(offset, offset + 4);
    offset += 4;
  }
  if (buffer.length < offset + length) return undefined;

  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (mask !== undefined) {
    for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ mask[i % 4]!;
  }
  return { opcode, payload, size: offset + length };
}

function sameGeometry(a: Geometry | undefined, b: Geometry): boolean {
  return a !== undefined && a.width === b.width && a.height === b.height && a.indexed === b.indexed;
}

/**
 * Read a client asset that lives beside this module.
 *
 * Two layouts have to work: running from source, where the assets sit next to
 * `server.ts`, and running from `dist`, where the build copies them alongside the
 * compiled JavaScript. Serving the wrong one produces a blank page with a 404 in
 * the console, which is a poor way to learn that a build step was missed - so a
 * missing asset is refused here, loudly, instead.
 */
function readAsset(name: string): string {
  for (const directory of [HERE, join(HERE, '..', '..', '..', 'src', 'host')]) {
    const path = join(directory, name);
    if (existsSync(path)) return readFileSync(path, 'utf8');
  }
  throw new Error(
    `VerixOS cannot start: ${name} was not found next to ${HERE}. ` +
      'Run the build (npm run build), or start from source with: npm start -- live',
  );
}

/* -------------------------------------------------------------------------- */
/* The host                                                                    */
/* -------------------------------------------------------------------------- */

export function createDesktopHost(options: DesktopHostOptions): DesktopHost {
  const { kernel } = options;
  const fps = options.fps ?? 30;
  const bootHoldMs = options.bootHoldMs ?? 1800;

  const sockets = new Set<Socket>();
  let timer: NodeJS.Timeout | undefined;
  let bootPixels: Uint32Array | undefined;
  let bootWidth = 0;
  let bootHeight = 0;
  let servingBoot = false;
  let bootStarted = 0;
  /**
   * The geometry each client has already been told.
   *
   * Tracked per socket rather than globally because a client that connects halfway
   * through the boot has not been told the boot screen's size, and sending a boot
   * frame to it without saying so first would paint a 320x200 canvas with 768 000
   * bytes of RGB.
   */
  const announced = new Map<Socket, Geometry>();
  let lastSent = 0;
  let lastFrame: { written: number; examined: number } | undefined;
  let port = 0;

  const palette = kernel.machine.vga.palette;

  const desktopGeometry: Geometry = { width: 320, height: 200, indexed: true };

  function currentGeometry(): Geometry {
    if (servingBoot && bootPixels !== undefined) {
      return { width: bootWidth, height: bootHeight, indexed: false };
    }
    return desktopGeometry;
  }

  /**
   * The bytes for one frame.
   *
   * Two formats, because the two screens genuinely differ: the boot console is
   * text mode, which this adapter renders to RGB rather than to palette indices
   * through the aperture, and the desktop is 320x200 index data straight out of the
   * frame buffer. Converting the desktop to RGB to make them uniform would triple
   * the bandwidth for the screen that is actually interactive.
   */
  function currentFrame(): Uint8Array {
    if (servingBoot && bootPixels !== undefined) {
      const out = new Uint8Array(bootPixels.length * 3);
      for (let i = 0; i < bootPixels.length; i++) {
        const rgb = bootPixels[i]!;
        out[i * 3] = (rgb >>> 16) & 0xff;
        out[i * 3 + 1] = (rgb >>> 8) & 0xff;
        out[i * 3 + 2] = rgb & 0xff;
      }
      return out;
    }
    return kernel.machine.vga.framebuffer.subarray(0, desktopGeometry.width * desktopGeometry.height);
  }

  /** The palette, as 256 RGB triples, sent once per connection. */
  function palettePayload(): Buffer {
    const out = new Uint8Array(256 * 3);
    for (let i = 0; i < 256; i++) {
      const rgb = palette[i] ?? 0;
      out[i * 3] = (rgb >>> 16) & 0xff;
      out[i * 3 + 1] = (rgb >>> 8) & 0xff;
      out[i * 3 + 2] = rgb & 0xff;
    }
    return Buffer.from(out);
  }

  function send(socket: Socket, payload: Uint8Array, opcode = 0x02): void {
    if (socket.destroyed) return;
    socket.write(encodeFrame(payload, opcode));
  }

  /**
   * Tell a client the screen's shape, but only when it has changed.
   *
   * The desktop's geometry never changes, so a client that has been told it once
   * never needs telling again - and re-sending it on every frame would triple the
   * message count to convey nothing.
   */
  function sendGeometry(socket: Socket, force = false): void {
    const geometry = currentGeometry();
    if (!force && sameGeometry(announced.get(socket), geometry)) return;
    announced.set(socket, geometry);
    send(socket, Buffer.from(JSON.stringify({ kind: 'geometry', ...geometry })), 0x01);
  }

  /**
   * Present one frame.
   *
   * The frame is only sent when something changed, or once a second regardless, so
   * a genuinely idle desktop does not keep pushing 64 kB frames that say nothing.
   */
  function pump(): void {
    const now = Date.now();

    if (servingBoot) {
      if (now - bootStarted >= bootHoldMs) servingBoot = false;
      if (sockets.size > 0) {
        for (const socket of sockets) {
          sendGeometry(socket);
          send(socket, currentFrame());
        }
      }
      return;
    }

    const stats = kernel.tick();
    lastFrame = { written: stats.written, examined: stats.examined };
    if (stats.written > 0 || now - lastSent > 1000) {
      lastSent = now;
      for (const socket of sockets) send(socket, currentFrame());
    }
  }

  function handleInput(text: string): void {
    let message: { t?: string; x?: number; y?: number; b?: number; n?: number };
    try {
      message = JSON.parse(text) as typeof message;
    } catch {
      // A malformed message is ignored rather than fatal. The client is the only
      // thing talking to this, and one bad frame should not take the desktop down.
      return;
    }
    const now = Date.now();
    switch (message.t) {
      case 'move':
        kernel.movePointer(message.x ?? 0, message.y ?? 0, message.b ?? 1);
        return;
      case 'down':
        kernel.pointerButton(message.b ?? 0, true, now);
        return;
      case 'up':
        kernel.pointerButton(message.b ?? 0, false, now);
        return;
      case 'wheel':
        kernel.pointerWheel(message.n ?? 0);
        return;
      case 'key':
        // Scancodes go to the keyboard controller, not straight to the desktop, so
        // that a guest reading port 0x60 sees the stream a real machine produces.
        kernel.pressScanCode(message.n ?? 0, message.b === 1);
        return;
      case 'keyup':
        kernel.releaseScanCode(message.n ?? 0, message.b === 1);
        return;
      case 'reset':
        servingBoot = false;
        // A reset can change the geometry if it lands while the boot console is up,
        // so the next frame re-announces it.
        announced.clear();
        kernel.resetDesktop();
        return;
      default:
    }
  }

  function attach(socket: Socket): void {
    sockets.add(socket);
    let buffer = Buffer.alloc(0);

    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const frame = decodeFrame(buffer);
        if (frame === undefined) break;
        buffer = buffer.subarray(frame.size);
        if (frame.opcode === 0x08) {
          socket.end();
          return;
        }
        if (frame.opcode === 0x01 || frame.opcode === 0x02) handleInput(frame.payload.toString('utf8'));
      }
    });

    const forget = (): void => {
      sockets.delete(socket);
      announced.delete(socket);
      if (sockets.size === 0) stopPump();
    };
    socket.on('error', forget);
    socket.on('close', forget);

    // The palette is announced before it is sent. Sniffing it out of the byte
    // stream by its length would work only until some screen happened to be 768
    // bytes wide, and the failure would be a screen painted in the wrong colours
    // with no error anywhere.
    send(socket, Buffer.from(JSON.stringify({ kind: 'palette', entries: 256 })), 0x01);
    send(socket, palettePayload());
    sendGeometry(socket, true);
    startPump();
  }

  function startPump(): void {
    if (timer !== undefined) return;
    lastSent = 0;
    timer = setInterval(pump, Math.max(1, Math.floor(1000 / fps)));
  }

  function stopPump(): void {
    if (timer === undefined) return;
    clearInterval(timer);
    timer = undefined;
  }

  const pageHtml = readAsset('client.html');
  const scriptJs = readAsset('client.js');

  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = request.url ?? '/';
    if (url.startsWith('/client.js')) {
      response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
      response.end(scriptJs);
      return;
    }
    if (url.startsWith('/palette')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(Array.from(palette)));
      return;
    }
    if (url.startsWith('/screenshot.png')) {
      const png = Buffer.from(encodePng(kernel.pixels(), 320, 200));
      // An explicit length, so the response is not chunked. The body is known
      // before it is sent, and a client that has to reassemble chunks to learn
      // how big a PNG is has been given more work than necessary for no gain.
      response.writeHead(200, {
        'content-type': 'image/png',
        'content-length': String(png.length),
        'cache-control': 'no-store',
      });
      response.end(png);
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(pageHtml);
  });

  server.on('upgrade', (request, socket) => {
    const key = request.headers['sec-websocket-key'];
    if (typeof key !== 'string') {
      socket.destroy();
      return;
    }
    const accept = createHash('sha1').update(key + WEBSOCKET_GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    attach(socket as Socket);
  });

  return {
    get url(): string {
      return `http://${options.host ?? '127.0.0.1'}:${port}`;
    },
    get port(): number {
      return port;
    },
    get clients(): number {
      return sockets.size;
    },
    get lastFrame(): { written: number; examined: number } | undefined {
      return lastFrame;
    },
    listen(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => {
          const address = server.address();
          if (address !== null && typeof address === 'object') port = address.port;
          resolve();
        });
      });
    },
    close(): Promise<void> {
      stopPump();
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      return new Promise((resolve) => server.close(() => resolve()));
    },
    showBootConsole(): void {
      const capture = kernel.bootScreen;
      if (capture === undefined) return;
      bootPixels = capture.pixels;
      bootWidth = capture.width;
      bootHeight = capture.height;
      servingBoot = true;
      bootStarted = Date.now();
    },
  };
}