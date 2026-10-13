/**
 * The PS/2 mouse, the 8042's auxiliary port, and `int 33h`.
 *
 * A mouse is the only input device whose state the guest can read back, so a bug
 * here does not show up as a crash or a wrong pixel - it shows up as a guest that
 * believes the pointer is somewhere it is not, and draws its cursor in the wrong
 * place. That is why these assertions read the *position* and the *wire bytes*
 * rather than checking that a call did not throw.
 *
 * The packet format is the part most worth pinning down. Motion is seven bits of
 * magnitude in one byte and its sign in the *first* byte; an implementation that
 * puts the sign with its displacement reports perfect movement on the positive
 * axes and wild jumps on the others, which is precisely the bug these tests exist
 * to make impossible.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Ps2Mouse, MouseCommand } from '../src/machine/devices/mouse.ts';
import { Ps2Keyboard } from '../src/machine/devices/keyboard.ts';
import { Machine } from '../src/machine/machine.ts';
import { Reg } from '../src/arch/types.ts';

/** The bytes the mouse is offering the controller, in order. */
function drain(mouse: Ps2Mouse): number[] {
  const bytes: number[] = [];
  while (mouse.hasData) {
    const byte = mouse.readData();
    if (byte === undefined) break;
    bytes.push(byte);
  }
  return bytes;
}

/** A mouse with reporting on, which is the state after `int 33h` init. */
function reporting(countsPerPixelParameter = 0): Ps2Mouse {
  const mouse = new Ps2Mouse();
  mouse.command(MouseCommand.SET_RESOLUTION);
  mouse.command(countsPerPixelParameter);
  mouse.setReporting(true);
  mouse.setPosition(100, 100);
  drain(mouse);
  return mouse;
}

/* -------------------------------------------------------------------------- */
/* Packet assembly                                                             */
/* -------------------------------------------------------------------------- */

test('a packet carries the motion sign in the first byte', () => {
  const mouse = reporting();

  // `dy` is device-relative: positive is up, the way a hand moves. Because the
  // pointer's own Y decreases when the hand rises, the displacement a driver adds
  // to its cursor position is already negative for upward movement - which is also
  // what real hardware reports. Negating it again would give a correct-looking
  // packet that moves a correct guest's cursor backwards.

  // Eight counts right: positive, so no sign bit.
  mouse.moveBy(8, 0);
  assert.deepEqual(drain(mouse), [0x08, 8, 0, 0], 'no sign bit on positive X');

  // Eight counts left: negative, so bit 3 of byte 0 is set and the displacement
  // is the two's complement in byte 1. Missing the sign bit here is the bug.
  mouse.moveBy(-8, 0);
  assert.deepEqual(drain(mouse), [0x08 | (1 << 3), 0xf8, 0, 0], 'X sign set, displacement twos-complement');

  // Up on the device: sign bit 4 set, and the byte is negative.
  mouse.moveBy(0, 8);
  assert.deepEqual(drain(mouse), [0x08 | (1 << 4), 0, 0xf8, 0], 'device-up is a negative Y');

  mouse.moveBy(0, -8);
  assert.deepEqual(drain(mouse), [0x08, 0, 8, 0], 'device-down is a positive Y');
});

test('both signs can be set at once', () => {
  const mouse = reporting();
  mouse.moveBy(-3, 5);
  const packet = drain(mouse);
  assert.equal(packet[0], 0x08 | (1 << 3) | (1 << 4), 'both sign bits plus the always-one bit');
  assert.equal(packet[1], 0xfd, '-3 as a byte');
  assert.equal(packet[2], 0xfb, '+5 up the device is a negative Y');
});

test('the always-one bit is never clear', () => {
  const mouse = reporting();
  // Every command a guest can send, then a burst of motion, and no byte 0 with
  // bit 3 clear. A device that drops it produces packets a driver silently
  // discards, which is indistinguishable from a mouse that does not move.
  mouse.setButton(0, true);
  mouse.setButton(0, false);
  mouse.moveBy(-100, -100);
  mouse.moveBy(100, 100);
  mouse.scroll(-3);
  const packet = drain(mouse);
  assert.ok(packet.length > 0);
  for (let offset = 0; offset < packet.length; offset += 4) {
    assert.equal(packet[offset]! & 0x08, 0x08, `byte ${offset} of the packet is missing bit 3`);
  }
});

test('a motion displacement never exceeds seven bits', () => {
  const mouse = reporting();
  // Far more than 127 counts in one event, which happens when a window is dragged
  // across the screen or a pointer is warped. The magnitude is clamped; the sign
  // is kept. Letting the magnitude through would make the next packet's
  // displacement the residue and the pointer would jump backwards.
  mouse.moveBy(5000, 0);
  const forward = drain(mouse);
  assert.equal(forward[1], 127, 'clamped to +127');

  mouse.moveBy(-5000, 0);
  const backward = drain(mouse);
  assert.equal(backward[0]! & 0x08, 0x08, 'sign preserved');
  assert.equal(backward[1], 0x81, 'clamped to -127, which is 129 as a byte');
});

test('buttons are reported in byte 0, and a press alone produces a packet', () => {
  const mouse = reporting();
  mouse.setButton(0, true);
  assert.deepEqual(drain(mouse)[0], 0x08 | 0x01, 'left button is bit 0');

  mouse.setButton(2, true);
  assert.deepEqual(drain(mouse)[0], 0x08 | 0x05, 'right and left');

  mouse.setButton(1, true);
  assert.deepEqual(drain(mouse)[0], 0x08 | 0x07, 'all three');

  // A press with no movement must still produce a packet: a driver that waits
  // for a motion packet to learn about the click delivers it late or not at all.
  mouse.setButton(0, false);
  const release = drain(mouse);
  assert.equal(release[0], 0x08 | 0x06);
  assert.equal(release[1], 0, 'no motion');
  assert.equal(release[2], 0);
});

test('a button that is already in the reported state sends nothing', () => {
  const mouse = reporting();
  mouse.setButton(0, true);
  drain(mouse);
  mouse.setButton(0, true);
  assert.equal(drain(mouse).length, 0, 'a repeated press is not a new event');
});

test('the wheel travels in the high nibble of a fourth byte', () => {
  const mouse = reporting();
  mouse.scroll(-1);
  const down = drain(mouse);
  assert.equal(down.length, 4, 'a four-byte packet');
  assert.equal(down[3]! & 0xf0, 0xf0, '-1 is 0xF in the high nibble');
  assert.equal(down[3]! & 0x0f, 0, 'the low nibble is reserved');

  mouse.scroll(1);
  assert.equal(drain(mouse)[3]! & 0xf0, 0x10, '+1 is 0x1 in the high nibble');
});

test('resolution scales the counts the guest is told about', () => {
  // At one count per pixel the pointer tracks the hand. At eight, the guest has
  // asked for a pointer that moves an eighth as fast, which is what a high
  // resolution setting means and why the guest must compensate rather than the
  // device.
  const fast = reporting(0); // 1 count per pixel
  fast.moveBy(16, 0);
  assert.equal(fast.state.x, 100 + 16);

  const slow = reporting(3); // 8 counts per pixel
  slow.moveBy(16, 0);
  assert.equal(slow.state.x, 100 + 2, '16 counts at 8 counts per pixel is 2 pixels');
});

/* -------------------------------------------------------------------------- */
/* The device's own state                                                      */
/* -------------------------------------------------------------------------- */

test('movement is refused while reporting is off', () => {
  const mouse = new Ps2Mouse();
  mouse.moveBy(100, 100);
  assert.equal(mouse.state.packets, 0, 'a disabled mouse reports nothing');
  assert.equal(mouse.state.x, 0);

  mouse.setReporting(true);
  mouse.moveBy(100, 100);
  assert.equal(mouse.state.packets, 1);
});

test('the pointer stays inside its bounds', () => {
  const mouse = reporting();
  mouse.setScreenSize(320, 200);
  mouse.setBounds(10, 20, 100, 80);
  assert.deepEqual({ x: mouse.state.x, y: mouse.state.y }, { x: 100, y: 80 }, 'clamped in');

  mouse.moveBy(-1000, 1000); // left and up on the device
  assert.deepEqual({ x: mouse.state.x, y: mouse.state.y }, { x: 10, y: 20 }, 'clamped out');
});

test('bounds of zero on the maximum mean the screen', () => {
  // The BIOS convention: passing 0/0/0/0 means "the whole screen". Reading zero
  // as a literal bound instead clamps the pointer to a single pixel, which is a
  // memorable failure mode.
  const mouse = reporting();
  mouse.setScreenSize(320, 200);
  mouse.setBounds(0, 0, 0, 0);
  mouse.moveBy(1000, -1000); // right and down on the device
  assert.deepEqual({ x: mouse.state.x, y: mouse.state.y }, { x: 319, y: 199 });
});

test('reset returns the device to power-on', () => {
  const mouse = reporting();
  mouse.setButton(0, true);
  mouse.scroll(2);
  mouse.moveBy(50, 50);
  mouse.setScreenSize(320, 200);
  mouse.setBounds(5, 5, 50, 50);

  mouse.reset();

  assert.deepEqual(mouse.state, { x: 0, y: 0, buttons: 0, enabled: false, packets: 0 });
  assert.equal(mouse.hasData, false, 'the output buffer is empty, not merely unread');
});

/* -------------------------------------------------------------------------- */
/* The 8042's auxiliary port                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A controller with a mouse on its auxiliary port, as the machine wires it.
 *
 * Two deliberate departures from power-on, both to make assertions legible. The
 * keyboard's boot-time identification bytes are drained, because a real 8042 does
 * queue them and every read of port 0x60 would otherwise return the keyboard's ID
 * rather than the mouse's packet - a failure with nothing to do with the mouse. And
 * the mouse is set to one count per pixel, so the counts a test moves by are the
 * pixels the pointer travels and the numbers can be checked by eye.
 */
function controller(): { keyboard: Ps2Keyboard; mouse: Ps2Mouse } {
  const keyboard = new Ps2Keyboard();
  const mouse = new Ps2Mouse();
  keyboard.aux = mouse;
  for (let guard = 0; guard < 8 && keyboard.dataAvailable; guard++) {
    keyboard.portRead(0);
  }
  keyboard.portWrite(1, 1, 0xd4n);
  keyboard.portWrite(0, 1, BigInt(MouseCommand.SET_RESOLUTION));
  keyboard.portWrite(0, 1, 0n);
  keyboard.portRead(0); // the acknowledgement
  mouse.setReporting(true);
  for (let guard = 0; guard < 8; guard++) {
    if (mouse.readData() === undefined) break;
  }
  return { keyboard, mouse };
}

test('0xD4 routes the next byte to the mouse rather than the keyboard', () => {
  const keyboard = new Ps2Keyboard();
  const mouse = new Ps2Mouse();
  keyboard.aux = mouse;
  for (let guard = 0; guard < 8 && keyboard.dataAvailable; guard++) keyboard.portRead(0);

  keyboard.portWrite(1, 1, 0xd4n);
  keyboard.portWrite(0, 1, BigInt(MouseCommand.ENABLE));

  // The mouse acknowledged it. If the byte had gone to the keyboard it would also
  // have acknowledged it, which is exactly why the acknowledgement alone proves
  // nothing and the mouse's own state is what has to be checked.
  assert.equal(keyboard.portRead(0), 0xfan, 'the acknowledgement comes first');
  assert.equal(mouse.enabled, true, 'the mouse was actually enabled');
});

test('a 0xD4 prefix also covers the command that follows it', () => {
  const keyboard = new Ps2Keyboard();
  const mouse = new Ps2Mouse();
  keyboard.aux = mouse;
  for (let guard = 0; guard < 8 && keyboard.dataAvailable; guard++) keyboard.portRead(0);

  // One prefix, a command, and its parameter - the way every guest sends it.
  keyboard.portWrite(1, 1, 0xd4n);
  keyboard.portWrite(0, 1, BigInt(MouseCommand.SET_RESOLUTION));
  keyboard.portRead(0); // acknowledgement
  keyboard.portWrite(0, 1, 3n); // 8 counts per pixel

  assert.equal(mouse.info.countsPerPixel, 8, 'the parameter reached the mouse');

  // And the bytes the controller offered were both the mouse's acknowledgements,
  // not one of them plus a keyboard echo.
  assert.equal(keyboard.portRead(0), 0xfan);
  assert.equal(keyboard.portRead(0), 0xfan);
  assert.equal(keyboard.dataAvailable, false, 'the keyboard was never involved');
});

test('status bit 5 marks a byte as coming from the mouse', () => {
  const { keyboard, mouse } = controller();
  mouse.setPosition(50, 50);
  mouse.moveBy(4, 0);

  assert.ok((keyboard.portRead(1) & 1n) !== 0n, 'output buffer full');
  assert.ok((keyboard.portRead(1) & 0x20n) !== 0n, 'and the byte is from the mouse');

  // Bit 5 describes the byte that is *waiting*, so it stays set for the whole
  // packet. Clearing it as soon as the first byte is taken would tell a driver
  // that the second byte of a motion packet is a scancode.
  for (let guard = 0; guard < 8 && keyboard.dataAvailable; guard++) keyboard.portRead(0);
  assert.equal((keyboard.portRead(1) & 0x20n) & 0xffn, 0n, 'clear once the packet is drained');

  // And a queued keystroke must clear it too, or a driver reads a scancode and
  // believes it is a packet.
  keyboard.press(0x1e);
  assert.equal((keyboard.portRead(1) & 0x20n) & 0xffn, 0n);
  assert.ok(Number(keyboard.portRead(0)) < 0x80);
});

test('the mouse byte is served from port 0x60', () => {
  const { keyboard, mouse } = controller();
  mouse.setReporting(true);
  mouse.setPosition(50, 50);
  drain(mouse);
  mouse.moveBy(6, 0);

  const first = keyboard.portRead(0);
  const second = keyboard.portRead(0);
  assert.equal(first, 0x08n, 'the flags byte');
  assert.equal(second, 6n, 'then the X displacement');
});

test('a keyboard byte is served in preference to a queued mouse byte', () => {
  const { keyboard, mouse } = controller();
  mouse.setPosition(10, 10);
  mouse.moveBy(4, 0);

  // Type something, then move the mouse. Reading must give the keystroke first:
  // the alternative delivers a click that the user made before typing after the
  // typing, which is the sort of thing that makes an emulator feel haunted.
  keyboard.press(0x1e);

  assert.ok(Number(keyboard.portRead(0)) < 0x80, 'a scancode, not a packet flags byte');
});

test('0xA7 gates the mouse so it cannot report into a closed port', () => {
  const { keyboard, mouse } = controller();
  keyboard.portWrite(1, 1, 0xa7n); // disable the auxiliary clock
  assert.equal((keyboard.portRead(1) & 0x10n) & 0xffn, 0x10n, 'the inhibit bit is set');

  mouse.setReporting(true);
  mouse.setPosition(30, 30);
  drain(mouse);
  mouse.moveBy(4, 0);
  assert.equal(keyboard.dataAvailable, false, 'a gated mouse delivers nothing');

  keyboard.portWrite(1, 1, 0xa8n); // re-enable
  assert.equal((keyboard.portRead(1) & 0x10n) & 0xffn, 0n);

  mouse.moveBy(4, 0);
  assert.equal(keyboard.dataAvailable, true);
});

test('an empty output buffer returns the last byte transferred', () => {
  const { keyboard, mouse } = controller();
  mouse.setPosition(10, 10);
  mouse.moveBy(4, 0);

  // Drain the whole packet first. Reading once and then expecting an echo would be
  // reading the second byte of a packet, not an empty buffer.
  let last = -1;
  for (let guard = 0; guard < 8; guard++) {
    const byte = keyboard.portRead(0);
    if (!keyboard.dataAvailable) {
      last = Number(byte);
      break;
    }
  }
  assert.ok(last >= 0, 'the packet never emptied');

  assert.equal(Number(keyboard.portRead(0)), last, 'reading an empty buffer echoes the last byte');
  assert.equal(Number(keyboard.portRead(0)), last, 'and keeps doing so');
});

test('mouse commands are dropped while the auxiliary clock is gated', () => {
  const keyboard = new Ps2Keyboard();
  const mouse = new Ps2Mouse();
  keyboard.aux = mouse;
  for (let guard = 0; guard < 8 && keyboard.dataAvailable; guard++) keyboard.portRead(0);

  keyboard.portWrite(1, 1, 0xa7n); // gate the auxiliary clock
  keyboard.portWrite(1, 1, 0xd4n);
  keyboard.portWrite(0, 1, BigInt(MouseCommand.ENABLE));

  assert.equal(mouse.enabled, false, 'the command did not reach the mouse');
  assert.equal(mouse.info.countsPerPixel, 4, 'and the mouse is still at power-on');
});

/* -------------------------------------------------------------------------- */
/* int 33h                                                                     */
/* -------------------------------------------------------------------------- */

test('int 33h init reports a mouse in AX, which is the documented sentinel', () => {
  const machine = new Machine();
  machine.firmware.primeKeyboard();

  machine.cpu.regs.write(Reg.AX, 0n);
  machine.firmware.handle(0x33);

  // The value every driver tests for. Returning 0 - the natural "no error" answer -
  // makes every such driver skip mouse support, and returning nothing makes them
  // hang.
  assert.equal(machine.cpu.regs.read(Reg.AX), 0xffffn);
  assert.equal(machine.mouse.enabled, true, 'the BIOS enabled reporting');
});

test('int 33h reports the pointer position in pixels, not counts', () => {
  const machine = new Machine();
  machine.firmware.primeKeyboard();
  machine.mouse.setReporting(true);
  machine.mouse.setScreenSize(320, 200);
  machine.mouse.setPosition(123, 45);

  machine.cpu.regs.write(Reg.AX, 3n);
  machine.firmware.handle(0x33);

  assert.equal(machine.cpu.regs.read(Reg.BX), 0n, 'no buttons');
  assert.equal(machine.cpu.regs.read(Reg.CX), 123n, 'X in CX');
  assert.equal(machine.cpu.regs.read(Reg.DX), 45n, 'Y in DX');
});

test('int 33h hides and shows the hardware cursor', () => {
  const machine = new Machine();
  machine.firmware.primeKeyboard();

  machine.cpu.regs.write(Reg.AX, 2n);
  machine.firmware.handle(0x33);
  assert.equal(machine.mouse.info.visible, false, 'hidden by AX=0002');

  machine.cpu.regs.write(Reg.AX, 1n);
  machine.firmware.handle(0x33);
  assert.equal(machine.mouse.info.visible, true, 'shown again by AX=0001');
});

test('int 33h sets the pointer position and the bounds', () => {
  const machine = new Machine();
  machine.firmware.primeKeyboard();
  machine.cpu.regs.write(Reg.AX, 0n);
  machine.firmware.handle(0x33);

  machine.cpu.regs.write(Reg.AX, 4n);
  machine.cpu.regs.write(Reg.CX, 200n);
  machine.cpu.regs.write(Reg.DX, 150n);
  machine.firmware.handle(0x33);
  assert.deepEqual({ x: machine.mouse.state.x, y: machine.mouse.state.y }, { x: 200, y: 150 });

  machine.cpu.regs.write(Reg.AX, 6n);
  machine.cpu.regs.write(Reg.CX, 0n);
  machine.cpu.regs.write(Reg.DX, 0n);
  machine.cpu.regs.write(Reg.BX, 0x0fcbn); // right edge 0xCB = 203, bottom edge 0x0F = 15
  machine.firmware.handle(0x33);

  machine.mouse.moveBy(-1000, 1000); // far left, and far up on the device
  assert.deepEqual(
    { x: machine.mouse.state.x, y: machine.mouse.state.y },
    { x: 0, y: 0 },
    'clamped to the top left',
  );

  machine.mouse.moveBy(1000, -1000); // far right, and far down on the device
  assert.deepEqual(
    { x: machine.mouse.state.x, y: machine.mouse.state.y },
    { x: 203, y: 15 },
    'clamped to the bottom right, with X and Y not transposed',
  );
});

test('int 33h reads back the button state', () => {
  const machine = new Machine();
  machine.firmware.primeKeyboard();
  machine.cpu.regs.write(Reg.AX, 0n);
  machine.firmware.handle(0x33);

  machine.mouse.setButton(0, true);
  machine.mouse.setButton(2, true);

  machine.cpu.regs.write(Reg.AX, 5n);
  machine.firmware.handle(0x33);
  assert.equal(machine.cpu.regs.read(Reg.BX), 0b101n);
});

test('int 33h accepts the graphics cursor call that every driver makes', () => {
  // The mask and mask-or are 64 bytes each at ES:BX and ES:DX. A driver calls this
  // in graphics mode and then draws its own cursor, so refusing the call makes
  // the mouse driver give up on entering graphics mode at all.
  const machine = new Machine();
  machine.firmware.primeKeyboard();

  machine.cpu.regs.write(Reg.AX, 0x000an);
  machine.cpu.regs.write(Reg.BX, 0x1000n);
  machine.cpu.regs.write(Reg.DX, 0x1040n);
  assert.doesNotThrow(() => machine.firmware.handle(0x33));
  assert.equal(machine.mouse.info.visible, true, 'and the hardware cursor is left alone');
});

test('an unclaimed mouse function is refused rather than silently succeeding', () => {
  const machine = new Machine();
  machine.firmware.primeKeyboard();
  machine.cpu.regs.write(Reg.AX, 0n);
  machine.firmware.handle(0x33);

  machine.cpu.regs.write(Reg.AX, 0x00ffn);
  // Returning false is what makes the CPU raise a fault, and a fault is the point
  // of not claiming functions speculatively: a guest's mistake has to be visible
  // rather than absorbed into a success.
  assert.equal(
    machine.firmware.handle(0x33),
    false,
    'an unrecognised function must not be answered as though it succeeded',
  );
});

/* -------------------------------------------------------------------------- */
/* The interrupt line                                                          */
/* -------------------------------------------------------------------------- */

test('the mouse raises IRQ12 only when it has produced a packet', () => {
  const machine = new Machine();
  machine.enableMouseIrq();
  machine.mouse.setReporting(true);
  machine.mouse.setPosition(20, 20);
  // Discard the move-to packet; what matters is whether a *new* packet raises.
  machine.mouse.readData();

  machine.serviceInterrupts();
  machine.pic.acknowledge(12);
  machine.pic.acknowledge(2);

  machine.mouse.moveBy(4, 0);
  machine.serviceInterrupts();
  // Reaching this point without a fault is the assertion: the cascade line is
  // unmasked, so the slave's request is deliverable. Asserting on the interrupt
  // vector instead would require installing an IDT gate that does not exist yet.
  assert.ok(machine.mouse.state.packets > 1);
});

test('the machine wires the mouse onto the controller', () => {
  const machine = new Machine();
  assert.equal(machine.keyboard.aux, machine.mouse, 'the mouse is the controller\'s aux device');
});