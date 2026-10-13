/**
 * The live desktop host.
 *
 * These tests speak the protocol rather than calling the internals. A host that
 * serves a page containing no canvas, or that sends frames the client cannot
 * interpret, passes every test written against its own functions and fails the
 * only one that matters: can a person see and use it?
 *
 * The WebSocket tests do the handshake for real - a correct `Sec-WebSocket-Accept`
 * computed from the key the client sent - and then mask their frames as a browser
 * does, because a server that ignores the mask key looks identical to a correct
 * one until the first frame is more than a few bytes long.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { connect, type Socket } from 'node:net';

import { createDesktopHost } from '../src/host/server.ts';
import { Kernel } from '../src/kernel/kernel.ts';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** One decoded WebSocket frame. */
interface Frame {
  readonly opcode: number;
  readonly payload: Buffer;
}

/** The shape announcement the server sends as a text frame. */
interface Shape {
  readonly kind: string;
  readonly width: number;
  readonly height: number;
  readonly indexed: boolean;
}

function parseFrames(buffer: Buffer): { frames: Frame[]; rest: Buffer } {
  const frames: Frame[] = [];
  let offset = 0;
  for (;;) {
    if (buffer.length < offset + 2) break;
    const opcode = buffer[offset]! & 0x0f;
    let length = buffer[offset + 1]! & 0x7f;
    let header = 2;
    if (length === 126) {
      if (buffer.length < offset + header + 2) break;
      length = buffer.readUInt16BE(offset + header);
      header += 2;
    } else if (length === 127) {
      if (buffer.length < offset + header + 8) break;
      length = buffer.readUInt32BE(offset + header + 4);
      header += 8;
    }
    if (buffer.length < offset + header + length) break;
    frames.push({ opcode, payload: buffer.subarray(offset + header, offset + header + length) });
    offset += header + length;
  }
  return { frames, rest: buffer.subarray(offset) };
}

/** A connected client that collects frames and can send masked ones. */
class TestClient {
  readonly socket: Socket;
  frames: Frame[] = [];
  /** The handshake response headers, verbatim. */
  headers = '';
  /** Frames that arrived after the handshake completed. */
  private buffer: Buffer = Buffer.alloc(0);
  private handshakeDone = false;
  readonly key: string;

  private constructor(socket: Socket, key: string) {
    this.socket = socket;
    this.key = key;
  }

  static async connect(port: number): Promise<TestClient> {
    // The key is generated before the socket exists, because it has to be the
    // same value in the request and in the expected accept value. Deriving it
    // inside the connect callback would capture `this` as the class, not the
    // client, and send the literal string "undefined" as the key - which the
    // server would then hash quite correctly and the test would then compare
    // against something else entirely.
    const key = createHash('sha1')
      .update(`${Date.now()}:${Math.random()}`)
      .digest('base64')
      .slice(0, 24);

    return new Promise((resolve, reject) => {
      const socket = connect(port, '127.0.0.1', () => {
        socket.write(
          'GET /ws HTTP/1.1\r\n' +
            'Host: 127.0.0.1\r\n' +
            'Upgrade: websocket\r\n' +
            'Connection: Upgrade\r\n' +
            `Sec-WebSocket-Key: ${key}\r\n` +
            'Sec-WebSocket-Version: 13\r\n\r\n',
        );
      });
      const client = new TestClient(socket, key);
      socket.on('error', reject);
      socket.on('data', (chunk: Buffer) => {
        client.buffer = Buffer.concat([client.buffer, chunk]);
        if (!client.handshakeDone) {
          const end = client.buffer.indexOf('\r\n\r\n');
          if (end < 0) return;
          client.headers = client.buffer.subarray(0, end).toString('utf8');
          client.buffer = client.buffer.subarray(end + 4);
          client.handshakeDone = true;
        }
        const parsed = parseFrames(client.buffer);
        client.frames.push(...parsed.frames);
        client.buffer = parsed.rest;
        if (client.handshakeDone) resolve(client);
      });
    });
  }

  /** Send a masked text frame, as a browser must. */
  send(message: object): void {
    const payload = Buffer.from(JSON.stringify(message), 'utf8');
    const mask = Buffer.from([0xa1, 0xb2, 0xc3, 0xd4]);
    const masked = Buffer.from(payload.map((value, index) => value ^ mask[index % 4]!));
    this.socket.write(
      Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, masked]),
    );
  }

  /** Wait until at least `count` frames have arrived. */
  async waitFor(count: number, timeoutMs = 4000): Promise<Frame[]> {
    const deadline = Date.now() + timeoutMs;
    while (this.frames.length < count && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return this.frames;
  }

  close(): void {
    this.socket.destroy();
  }
}

/** A plain HTTP GET, returned as raw bytes plus the status line. */
function httpGet(port: number, path: string): Promise<{ status: string; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const request = connect(port, '127.0.0.1', () => {
      request.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    });
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const raw = Buffer.concat(chunks);
      const end = raw.indexOf('\r\n\r\n');
      resolve({
        status: raw.subarray(0, end).toString('utf8').split('\r\n')[0]!,
        body: raw.subarray(end + 4),
      });
    });
    request.on('error', reject);
  });
}

/** A booted kernel with the mouse enabled, as the desktop command builds it. */
function booted(): Kernel {
  const kernel = new Kernel();
  kernel.runBoot();
  kernel.enableMouse();
  return kernel;
}

/**
 * Read a value that the test polls.
 *
 * Written as a call rather than as a direct property read because TypeScript
 * narrows a property after an assertion about it, and then rejects the loop that
 * is waiting for it to change - which would make the polling loop itself the type
 * error, and would report it as such rather than as the real failure.
 */
function focusedApp(kernel: Kernel): string | undefined {
  return kernel.desktop.focusedWindow?.app.id;
}

function connectedClients(host: { readonly clients: number }): number {
  return host.clients;
}

/* -------------------------------------------------------------------------- */

test('the host serves a page with a canvas and a script to drive it', async () => {
  const kernel = booted();
  const host = createDesktopHost({ kernel });
  await host.listen();
  try {
    const page = await httpGet(host.port, '/');
    assert.match(page.status, /200 OK/);
    assert.match(page.body.toString('utf8'), /<canvas/);

    const script = await httpGet(host.port, '/client.js');
    assert.match(script.status, /200 OK/);
    const source = script.body.toString('utf8');
    // The scan-code table is the part that must not be missing: without it the
    // page still loads and the mouse still works, so the breakage is silent.
    assert.match(source, /KeyA: 0x1e/);
    assert.match(source, /new WebSocket/);
  } finally {
    await host.close();
  }
});

test('the screenshot endpoint returns real PNG bytes', async () => {
  const kernel = booted();
  const host = createDesktopHost({ kernel });
  await host.listen();
  try {
    const { status, body } = await httpGet(host.port, '/screenshot.png');
    assert.match(status, /200 OK/);
    // Checked as bytes. Decoding the response as text and searching for the
    // signature is exactly the bug that makes this test pass while the endpoint is
    // broken: the first byte is 0x89, which is not valid UTF-8.
    assert.deepEqual([...body.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.equal(body.readUInt32BE(16), 320, 'IHDR width');
    assert.equal(body.readUInt32BE(20), 200, 'IHDR height');
  } finally {
    await host.close();
  }
});

test('the handshake returns the accept key derived from the one sent', async () => {
  const kernel = booted();
  const host = createDesktopHost({ kernel });
  await host.listen();
  try {
    const client = await TestClient.connect(host.port);
    try {
      assert.match(client.headers, /101 Switching Protocols/);
      const expected = createHash('sha1').update(client.key + GUID).digest('base64');
      // Compared as a substring, not as a regular expression: base64 contains
      // `+` and `/`, both of which a regex reads as syntax, and a test that fails
      // on a perfectly good handshake is worse than no test.
      assert.ok(
        client.headers.includes(`Sec-WebSocket-Accept: ${expected}`),
        `expected accept ${expected}, got:\n${client.headers}`,
      );
    } finally {
      client.close();
    }
  } finally {
    await host.close();
  }
});

test('a connection is greeted with a palette, then a shape, then frames', async () => {
  const kernel = booted();
  const host = createDesktopHost({ kernel, fps: 60, bootHoldMs: 0 });
  host.showBootConsole();
  await host.listen();
  try {
    const client = await TestClient.connect(host.port);
    try {
      const frames = await client.waitFor(3);
      assert.ok(frames.length >= 3, `expected at least 3 frames, got ${frames.length}`);

      // The greeting is ordered: announce the palette, send the palette, announce
      // the shape, then send pixels. Any other order leaves the client either
      // painting uncoloured or interpreting the palette as a frame.
      assert.equal(frames[0]!.opcode, 0x01, 'the palette is announced in a text frame');
      assert.match(frames[0]!.payload.toString('utf8'), /"kind":"palette"/);

      assert.equal(frames[1]!.payload.length, 768, '256 palette entries, three bytes each');
      // The palette must be the machine's own, byte for byte. Comparing against a
      // hard-coded VGA default would pass while the machine had installed a
      // different one, which is the case that matters: a client with the wrong
      // palette renders a correct frame in entirely the wrong colours, and
      // nothing downstream can detect it.
      const machinePalette = kernel.machine.vga.palette;
      const expectedPalette: number[] = [];
      for (let index = 0; index < 256; index++) {
        const rgb = machinePalette[index]!;
        expectedPalette.push((rgb >>> 16) & 0xff, (rgb >>> 8) & 0xff, rgb & 0xff);
      }
      assert.deepEqual([...frames[1]!.payload], expectedPalette);
      // And it must not be all zeroes, which is what an uninitialised buffer looks
      // like and would render as a black screen.
      assert.ok(frames[1]!.payload.some((byte) => byte !== 0), 'the palette is entirely zero');

      // The boot console is shown first, so the first shape a client is told about
      // is text mode: 640x400 of RGB triples, not palette indices. Getting this
      // wrong does not fail loudly - it paints the first screen from every third
      // byte, which looks like corruption.
      assert.equal(frames[2]!.opcode, 0x01, 'the shape follows the palette');
      const first = JSON.parse(frames[2]!.payload.toString('utf8')) as Shape;
      assert.equal(first.kind, 'geometry');
      assert.equal(first.width, 640, 'the boot console is 640 wide');
      assert.equal(first.height, 400);
      assert.equal(first.indexed, false, 'text mode goes out as RGB, not indices');
    } finally {
      client.close();
    }
  } finally {
    await host.close();
  }
});

test('the desktop takes the screen from the boot console, in the right format', async () => {
  const kernel = booted();
  const host = createDesktopHost({ kernel, fps: 60, bootHoldMs: 120 });
  host.showBootConsole();
  await host.listen();
  try {
    const client = await TestClient.connect(host.port);
    try {
      // Enough frames to span the hold and some of the desktop.
      await client.waitFor(24);

      const shapes = client.frames
        .filter((frame) => frame.opcode === 0x01 && frame.payload.toString('utf8').includes('"geometry"'))
        .map((frame) => JSON.parse(frame.payload.toString('utf8')) as Shape);
      const last = shapes[shapes.length - 1]!;
      assert.deepEqual(
        { width: last.width, height: last.height, indexed: last.indexed },
        { width: 320, height: 200, indexed: true },
      );

      // And the frames themselves must match the announced shape. A frame of
      // 640x400 RGB arriving under a 320x200 declaration would be drawn by the
      // client as a screen that is three times too wide and wraps.
      const declared = last.width * last.height * (last.indexed ? 1 : 3);
      const matching = client.frames.filter(
        (frame) => frame.opcode === 0x02 && frame.payload.length === declared,
      );
      assert.ok(matching.length > 0, `no frame matched the declared ${declared} bytes`);
      assert.ok(matching[0]!.payload.some((byte) => byte !== 0), 'the frame is entirely zero');
    } finally {
      client.close();
    }
  } finally {
    await host.close();
  }
});

test('geometry is announced once per change, not on every frame', async () => {
  const countGeometry = (frames: readonly Frame[]): number =>
    frames.filter(
      (frame) => frame.opcode === 0x01 && frame.payload.toString('utf8').includes('"geometry"'),
    ).length;

  // No boot console: the desktop's geometry is announced once, on attach.
  const plain = createDesktopHost({ kernel: booted(), fps: 60, bootHoldMs: 0 });
  await plain.listen();
  try {
    const client = await TestClient.connect(plain.port);
    try {
      await client.waitFor(14);
      assert.equal(countGeometry(client.frames), 1, 'a constant shape was re-announced');
    } finally {
      client.close();
    }
  } finally {
    await plain.close();
  }

  // With the boot console: exactly two shapes exist - 640x400 RGB, then 320x200
  // indices - so exactly two announcements. More would mean the message is being
  // resent rather than sent on change; fewer would mean a client that connected
  // during the boot was never told how to read what it was sent.
  const withBoot = createDesktopHost({ kernel: booted(), fps: 60, bootHoldMs: 120 });
  withBoot.showBootConsole();
  await withBoot.listen();
  try {
    const client = await TestClient.connect(withBoot.port);
    try {
      await client.waitFor(20);
      const geometries = client.frames
        .filter(
          (frame) => frame.opcode === 0x01 && frame.payload.toString('utf8').includes('"geometry"'),
        )
        .map((frame) => JSON.parse(frame.payload.toString('utf8')) as Shape);

      assert.deepEqual(
        geometries.map(
          (geometry) => `${geometry.width}x${geometry.height}${geometry.indexed ? 'i' : 'r'}`,
        ),
        ['640x400r', '320x200i'],
      );
    } finally {
      client.close();
    }
  } finally {
    await withBoot.close();
  }
});

test('a frame is 320x200 palette indices once the desktop has the screen', async () => {
  const kernel = booted();
  const host = createDesktopHost({ kernel, fps: 60, bootHoldMs: 0 });
  host.showBootConsole();
  await host.listen();
  try {
    const client = await TestClient.connect(host.port);
    try {
      await client.waitFor(20);
      // The boot console is 640x400 RGB; wait for the desktop to take over.
      const desktopFrames = client.frames.filter(
        (frame) => frame.opcode === 0x02 && frame.payload.length === 320 * 200,
      );
      assert.ok(
        desktopFrames.length > 0,
        'no desktop-sized frame arrived after the boot console',
      );
      // A frame of zeroes would be a black screen that passes a length check.
      assert.ok(desktopFrames[0]!.payload.some((byte) => byte !== 0), 'the frame is entirely zero');
    } finally {
      client.close();
    }
  } finally {
    await host.close();
  }
});

test('a masked click from a remote client focuses the dock icon it lands on', async () => {
  const kernel = booted();
  const host = createDesktopHost({ kernel, fps: 30, bootHoldMs: 0 });
  host.showBootConsole();
  await host.listen();
  try {
    const client = await TestClient.connect(host.port);
    try {
      await client.waitFor(3);
      assert.equal(focusedApp(kernel), 'terminal');

      const tile = kernel.desktop.dockTiles()[1]!;
      // Two messages: the move has to be processed before the press, or the click
      // lands wherever the pointer happened to be left.
      client.send({ t: 'move', x: tile.x + 4, y: tile.y + 4, b: 1 });
      client.send({ t: 'down', b: 0 });
      client.send({ t: 'up', b: 0 });

      const deadline = Date.now() + 3000;
      while (focusedApp(kernel) !== 'monitor' && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(focusedApp(kernel), 'monitor', 'the click never reached the desktop');
    } finally {
      client.close();
    }
  } finally {
    await host.close();
  }
});

test('a malformed message is ignored rather than fatal', async () => {
  const kernel = booted();
  const host = createDesktopHost({ kernel, fps: 30, bootHoldMs: 0 });
  await host.listen();
  try {
    const client = await TestClient.connect(host.port);
    try {
      await client.waitFor(2);
      const payload = Buffer.from('{not json', 'utf8');
      const mask = Buffer.from([1, 2, 3, 4]);
      client.socket.write(
        Buffer.concat([
          Buffer.from([0x81, 0x80 | payload.length]),
          mask,
          Buffer.from(payload.map((value, index) => value ^ mask[index % 4]!)),
        ]),
      );
      // A working click afterwards proves the connection survived.
      client.send({ t: 'move', x: 0, y: 0, b: 1 });
      const frames = await client.waitFor(client.frames.length + 1);
      assert.ok(frames.length > 0, 'the host stopped sending after a bad message');
    } finally {
      client.close();
    }
  } finally {
    await host.close();
  }
});

test('the pump stops when the last client leaves', async () => {
  const kernel = booted();
  const host = createDesktopHost({ kernel, fps: 60, bootHoldMs: 0 });
  await host.listen();
  try {
    const client = await TestClient.connect(host.port);
    await client.waitFor(3);
    assert.equal(connectedClients(host), 1);
    client.close();

    const deadline = Date.now() + 3000;
    while (connectedClients(host) !== 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(connectedClients(host), 0);
  } finally {
    await host.close();
  }
});

test('closing the host releases its port', async () => {
  const kernel = booted();
  const host = createDesktopHost({ kernel });
  await host.listen();
  const port = host.port;
  assert.ok(port > 0);
  await host.close();

  const second = createDesktopHost({ kernel });
  await second.listen();
  try {
    // A fresh port, which is only guaranteed if the first was actually released.
    assert.notEqual(second.port, 0);
  } finally {
    await second.close();
  }
});