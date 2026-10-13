/*
 * VerixOS - the browser half of the live desktop.
 *
 * Three jobs, and the interesting one is the middle:
 *
 *   1. Draw the frame buffer the server sends, at a whole-number scale.
 *   2. Turn browser events into the input a *machine* would receive - set 1 scan
 *      codes, not key names - and forward them.
 *   3. Scale the canvas to fill the window without distorting it.
 *
 * The scan-code table is the part worth reading. A key name like "KeyA" means
 * nothing to a guest: a PS/2 keyboard reports positions, and a driver that
 * received letters would have to reverse a layout table the hardware already has.
 * Sending scan codes means the guest's own translation is exercised, so a key typed
 * in the browser arrives at port 0x60 exactly as it would on real hardware.
 *
 * Everything is wrapped in a single function so a syntax error shows up as one
 * clear console message rather than a blank page.
 */

(function main() {
  'use strict';

  var canvas = document.getElementById('canvas');
  var statusEl = document.getElementById('status');
  var context = canvas.getContext('2d', { alpha: false });
  var imageData = null;
  var palette32 = new Uint32Array(256);
  var geometry = { width: 320, height: 200, indexed: true };
  var scale = 1;
  var socket = null;
  var frames = 0;
  var lastFpsAt = Date.now();
  var fps = 0;

  /* ---------------------------------------------------------------- */
  /* Palette and drawing                                                */
  /* ---------------------------------------------------------------- */

  function loadPalette(bytes) {
    var view = new Uint8Array(bytes);
    // One lookup entry per palette index, so a frame is a gather rather than
    // three channel extractions per pixel.
    for (var i = 0; i < 256; i++) {
      var r = view[i * 3] | 0;
      var g = view[i * 3 + 1] | 0;
      var b = view[i * 3 + 2] | 0;
      palette32[i] = 0xff000000 | (b << 16) | (g << 8) | r;
    }
  }

  function ensureBuffer() {
    var needed = geometry.width * geometry.height * 4;
    if (imageData === null || imageData.data.length !== needed) {
      imageData = context.createImageData(geometry.width, geometry.height);
    }
    canvas.width = geometry.width;
    canvas.height = geometry.height;
    resize();
  }

  function draw(payload) {
    var view = new Uint8Array(payload);
    var out = imageData.data;
    var count = geometry.width * geometry.height;
    var i, pixel;

    if (geometry.indexed) {
      for (i = 0; i < count; i++) {
        pixel = view[i] | 0;
        out[i * 4] = palette32[pixel] & 0xff;
        out[i * 4 + 1] = (palette32[pixel] >>> 8) & 0xff;
        out[i * 4 + 2] = (palette32[pixel] >>> 16) & 0xff;
        out[i * 4 + 3] = 255;
      }
    } else {
      // RGB triples: the boot console, which is text mode.
      for (i = 0; i < count; i++) {
        out[i * 4] = view[i * 3] | 0;
        out[i * 4 + 1] = view[i * 3 + 1] | 0;
        out[i * 4 + 2] = view[i * 3 + 2] | 0;
        out[i * 4 + 3] = 255;
      }
    }
    context.putImageData(imageData, 0, 0);

    frames++;
    var now = Date.now();
    if (now - lastFpsAt > 1000) {
      fps = Math.round((frames * 1000) / (now - lastFpsAt));
      frames = 0;
      lastFpsAt = now;
      statusEl.textContent = geometry.width + 'x' + geometry.height + ' at ' + scale + 'x - ' + fps + ' fps';
    }
  }

  /* ---------------------------------------------------------------- */
  /* Scaling                                                            */
  /* ---------------------------------------------------------------- */

  /**
   * Scale the canvas by the largest whole number that fits.
   *
   * Whole numbers only. A fractional scale makes every 1-pixel border a different
   * width and every straight line a slightly different shade, which is precisely
   * the thing that makes a pixel-art screen look like a screenshot of one rather
   * than the thing itself.
   */
  function resize() {
    var area = document.getElementById('screen');
    var available = area.getBoundingClientRect();
    var margin = 24;
    var fitX = Math.floor((available.width - margin) / geometry.width);
    var fitY = Math.floor((available.height - margin) / geometry.height);
    scale = Math.max(1, Math.min(fitX, fitY));
    canvas.style.width = geometry.width * scale + 'px';
    canvas.style.height = geometry.height * scale + 'px';
  }

  window.addEventListener('resize', resize);

  /* ---------------------------------------------------------------- */
  /* Socket                                                             */
  /* ---------------------------------------------------------------- */

  function send(message) {
    if (socket !== null && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }

  function connect() {
    socket = new WebSocket('ws://' + window.location.host + '/ws');
    socket.binaryType = 'arraybuffer';

    socket.addEventListener('open', function () {
      statusEl.textContent = 'connected';
      canvas.focus();
    });

    socket.addEventListener('close', function () {
      statusEl.textContent = 'disconnected - reload to reconnect';
    });

    socket.addEventListener('message', function (event) {
      if (typeof event.data === 'string') {
        var message = JSON.parse(event.data);
        if (message.kind === 'palette') {
          expectPalette = true;
        } else if (message.kind === 'geometry') {
          geometry = { width: message.width, height: message.height, indexed: !!message.indexed };
          ensureBuffer();
        }
        return;
      }
      if (expectPalette) {
        // The server announced the palette immediately before sending it.
        expectPalette = false;
        loadPalette(event.data);
        return;
      }
      draw(event.data);
    });
  }

  var expectPalette = false;

  /* ---------------------------------------------------------------- */
  /* Pointer                                                            */
  /* ---------------------------------------------------------------- */

  function toDesktop(event) {
    var box = canvas.getBoundingClientRect();
    return {
      x: Math.floor((event.clientX - box.left) / scale),
      y: Math.floor((event.clientY - box.top) / scale)
    };
  }

  canvas.addEventListener('contextmenu', function (event) {
    // The guest draws its own menus; the browser's would sit on top of them.
    event.preventDefault();
  });

  canvas.addEventListener('mousedown', function (event) {
    event.preventDefault();
    canvas.focus();
    var point = toDesktop(event);
    send({ t: 'move', x: point.x, y: point.y, b: scale });
    send({ t: 'down', b: event.button });
  });

  window.addEventListener('mouseup', function (event) {
    send({ t: 'up', b: event.button });
  });

  canvas.addEventListener('mousemove', function (event) {
    var point = toDesktop(event);
    send({ t: 'move', x: point.x, y: point.y, b: scale });
  });

  canvas.addEventListener(
    'wheel',
    function (event) {
      event.preventDefault();
      // Browsers report "scroll down" as a positive deltaY; a mouse wheel does
      // too, but the guest wants notches away from the user as positive, so the
      // sign is flipped once here rather than in every listener.
      send({ t: 'wheel', n: event.deltaY > 0 ? -1 : 1 });
    },
    { passive: false }
  );

  /* ---------------------------------------------------------------- */
  /* Keyboard                                                           */
  /* ---------------------------------------------------------------- */

  // Set 1 is not alphabetical: 'A' is 0x1E and 'Z' is 0x2C, with punctuation and
  // Enter and Control in between. Building this from `first + (letter - 'A')` sends
  // 'v' as 0x33, which is keypad 1.
  var SCAN = {
    Escape: 0x01, Digit1: 0x02, Digit2: 0x03, Digit3: 0x04, Digit4: 0x05,
    Digit5: 0x06, Digit6: 0x07, Digit7: 0x08, Digit8: 0x09, Digit9: 0x0a,
    Digit0: 0x0b, Minus: 0x0c, Equal: 0x0d, Backspace: 0x0e, Tab: 0x0f,
    KeyQ: 0x10, KeyW: 0x11, KeyE: 0x12, KeyR: 0x13, KeyT: 0x14, KeyY: 0x15,
    KeyU: 0x16, KeyI: 0x17, KeyO: 0x18, KeyP: 0x19, BracketLeft: 0x1a,
    BracketRight: 0x1b, Enter: 0x1c, ControlLeft: 0x1d, KeyA: 0x1e,
    KeyS: 0x1f, KeyD: 0x20, KeyF: 0x21, KeyG: 0x22, KeyH: 0x23, KeyJ: 0x24,
    KeyK: 0x25, KeyL: 0x26, Semicolon: 0x27, Quote: 0x28, Backquote: 0x29,
    ShiftLeft: 0x2a, Backslash: 0x2b, KeyZ: 0x2c, KeyX: 0x2d, KeyC: 0x2e,
    KeyV: 0x2f, KeyB: 0x30, KeyN: 0x31, KeyM: 0x32, Comma: 0x33, Period: 0x34,
    Slash: 0x35, ShiftRight: 0x36, NumpadMultiply: 0x37, AltLeft: 0x38,
    Space: 0x39, CapsLock: 0x3a, F1: 0x3b, F2: 0x3c, F3: 0x3d, F4: 0x3e,
    F5: 0x3f, F6: 0x40, F7: 0x41, F8: 0x42, F9: 0x43, F10: 0x44,
    NumLock: 0x45, ScrollLock: 0x46,
    Numpad7: 0x47, Numpad8: 0x48, Numpad9: 0x49, NumpadSubtract: 0x4a,
    Numpad4: 0x4b, Numpad5: 0x4c, Numpad6: 0x4d, NumpadAdd: 0x4e,
    Numpad1: 0x4f, Numpad2: 0x50, Numpad3: 0x51, Numpad0: 0x52,
    NumpadDecimal: 0x53, F11: 0x57, F12: 0x58,
    ArrowUp: 0x48, ArrowLeft: 0x4b, ArrowRight: 0x4d, ArrowDown: 0x50
  };

  // Keys that arrive after an 0xE0 prefix on set 1.
  var EXTENDED = {
    ArrowUp: 1, ArrowLeft: 1, ArrowRight: 1, ArrowDown: 1,
    NumpadEnter: 1, NumpadDivide: 1, NumpadDecimal: 1, Home: 1, End: 1,
    PageUp: 1, PageDown: 1, Insert: 1, Delete: 1, Numpad0: 1, Numpad1: 1,
    Numpad2: 1, Numpad3: 1, Numpad4: 1, Numpad6: 1, Numpad8: 1,
    ControlRight: 1, AltRight: 1
  };

  function onKey(event, down) {
    var code = SCAN[event.code];
    if (code === undefined) return false;
    send({ t: down ? 'key' : 'keyup', n: code, b: EXTENDED[event.code] ? 1 : 0 });
    return true;
  }

  window.addEventListener('keydown', function (event) {
    // The browser's own shortcuts would fight the guest's. Ctrl+L, Ctrl+T and the
    // rest are the browser's; everything the guest can use is forwarded.
    if (event.ctrlKey || event.metaKey) {
      if (event.code !== 'ControlLeft' && event.code !== 'ControlRight') return;
    }
    if (onKey(event, true)) {
      event.preventDefault();
      return;
    }
    if (event.key === 'Tab') event.preventDefault();
  });

  window.addEventListener('keyup', function (event) {
    if (onKey(event, false)) event.preventDefault();
  });

  /* ---------------------------------------------------------------- */
  /* Toolbar                                                            */
  /* ---------------------------------------------------------------- */

  document.getElementById('reset').addEventListener('click', function () {
    send({ t: 'reset' });
  });

  document.getElementById('shot').addEventListener('click', function () {
    window.open('/screenshot.png', '_blank');
  });

  document.getElementById('focus').addEventListener('click', function () {
    canvas.focus();
  });

  ensureBuffer();
  loadPalette(new Uint8Array(768));
  connect();
})();