/**
 * VerixOS - port I/O bus.
 *
 * x86 inherits a separate 16-bit port address space from the 8086. Devices claim
 * ranges within it and the CPU performs `in`/`out` against them.
 *
 * The bus uses the same discipline as `MemoryBus`: an unclaimed port access is
 * an error rather than a silent no-op, because on real hardware floating a
 * disabled device's register can produce bus contention, and silently dropping
 * the access would hide driver bugs during bring-up.
 *
 * Source: Intel SDM Vol. 1, Sec. 6.1.2 "I/O Instructions"; Vol. 2, Sec. 3.1.2.
 */

import { PortWidth } from '../arch/types.ts';

/** Raised when a port access targets no installed device. */
export class PortFault extends Error {
  readonly port: number;
  readonly direction: 'in' | 'out';
  readonly widthBytes: number;

  constructor(port: number, direction: 'in' | 'out', widthBytes: number, message?: string) {
    super(message ?? `${direction === 'in' ? 'read' : 'write'} of ${widthBytes} bytes at port 0x${port
      .toString(16)
      .padStart(2, '0')} has no registered device`);
    this.name = 'PortFault';
    this.port = port;
    this.direction = direction;
    this.widthBytes = widthBytes;
  }
}

/** A device claiming a contiguous port range. */
export interface PortDevice {
  readonly name: string;
  readonly startPort: number;
  /** Number of ports claimed. The claimed range is [startPort, startPort+size). */
  readonly portCount: number;

  /** Read `widthBytes` at `offset` bytes into the claimed range. */
  portRead(offset: number, widthBytes: number): bigint;
  /** Write `value` at `offset` bytes into the claimed range. */
  portWrite(offset: number, widthBytes: number, value: bigint): void;
}

export class PortIoBus {
  private readonly devices = new Map<number, PortDevice>();

  /**
   * Register a device.
   *
   * Overlapping registrations are a hard error. Silent overlap is one of those
   * bugs that only manifests as intermittent weirdness much later, so it is
   * rejected at bind time instead.
   */
  register(device: PortDevice): () => void {
    for (let i = 0; i < device.portCount; i++) {
      const port = device.startPort + i;
      const existing = this.devices.get(port);
      if (existing) {
        throw new Error(
          `port conflict: ${device.name} wants port 0x${port.toString(16)} but ${existing.name} already claims it`,
        );
      }
    }
    for (let i = 0; i < device.portCount; i++) {
      this.devices.set(device.startPort + i, device);
    }
    return () => {
      for (let i = 0; i < device.portCount; i++) this.devices.delete(device.startPort + i);
    };
  }

  ownerOf(port: number): PortDevice | undefined {
    return this.devices.get(port);
  }

  read(port: number, widthBytes: number = PortWidth.DWORD): bigint {
    const device = this.devices.get(port);
    if (!device) throw new PortFault(port, 'in', widthBytes);
    const last = device.startPort + device.portCount - 1;
    if (port + widthBytes - 1 > last) {
      throw new PortFault(port, 'in', widthBytes, `access of ${widthBytes} bytes crosses the end of ${device.name}'s range`);
    }
    return device.portRead(port - device.startPort, widthBytes);
  }

  write(port: number, value: bigint, widthBytes: number = PortWidth.DWORD): void {
    const device = this.devices.get(port);
    if (!device) throw new PortFault(port, 'out', widthBytes);
    const last = device.startPort + device.portCount - 1;
    if (port + widthBytes - 1 > last) {
      throw new PortFault(port, 'out', widthBytes, `access of ${widthBytes} bytes crosses the end of ${device.name}'s range`);
    }
    device.portWrite(port - device.startPort, widthBytes, value);
  }

  /** Device names in registration order. Used by `verix devices` and by tests. */
  deviceNames(): string[] {
    return [...new Set([...this.devices.values()].map((d) => d.name))];
  }

  /** Total number of claimed ports, used by diagnostics. */
  get claimedPortCount(): number {
    return this.devices.size;
  }
}

/**
 * Mask a port read result to `widthBytes` and widen it to a bigint.
 *
 * Some devices return a value wider than the access (a common shortcut); this
 * guarantees callers always see exactly the width they asked for, matching the
 * SDM's guarantee that upper bits are undefined-and-here-zeroed.
 */
export function maskPortValue(value: bigint, widthBytes: number): bigint {
  const mask = (1n << BigInt(widthBytes * 8)) - 1n;
  return value & mask;
}