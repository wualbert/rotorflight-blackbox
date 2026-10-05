#!/usr/bin/env python3
"""Read the blackbox flash of a Rotorflight/Betaflight flight controller over MSP, read-only.

Uses only MSP_API_VERSION, MSP_DATAFLASH_SUMMARY and MSP_DATAFLASH_READ; nothing is written to or erased
on the flight controller. Every request is timed, so the log shows whether and where the link stalls.

  python3 tools/flash_read.py /dev/cu.usbmodemXXXX --out log.bbl            # download
  python3 tools/flash_read.py /dev/cu.usbmodemXXXX --compare log.bbl       # verify an existing download
  python3 tools/flash_read.py /dev/cu.usbmodemXXXX --out log.bbl --resume  # continue a partial download

Close the Configurator first: it holds the serial port exclusively.
"""
import argparse
import os
import select
import struct
import sys
import termios
import time

MSP_API_VERSION, MSP_DATAFLASH_SUMMARY, MSP_DATAFLASH_READ = 1, 70, 71
BLOCK = 4096
TIMEOUT_S = 2.5      # same as the Configurator
SLOW_S = 0.5         # a response slower than this is logged on its own line


def open_port(path):
    fd = os.open(path, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
    attrs = termios.tcgetattr(fd)
    attrs[0] = 0                                             # input: raw
    attrs[1] = 0                                             # output: raw
    attrs[2] = termios.CS8 | termios.CREAD | termios.CLOCAL  # 8 bit, no modem control
    attrs[3] = 0                                             # no echo, no line editing
    attrs[4] = attrs[5] = termios.B115200                    # ignored by USB CDC, required by the API
    attrs[6][termios.VMIN] = 0
    attrs[6][termios.VTIME] = 0
    termios.tcsetattr(fd, termios.TCSANOW, attrs)
    termios.tcflush(fd, termios.TCIOFLUSH)
    return fd


def frame(cmd, payload=b''):
    body = bytes([len(payload), cmd]) + payload
    check = 0
    for b in body:
        check ^= b
    return b'$M<' + body + bytes([check])


class Link:
    def __init__(self, fd):
        self.fd, self.buf = fd, bytearray()

    def drain(self, quiet_s=0.05):
        """Discard everything in flight, so a late reply cannot be taken for the next one."""
        self.buf.clear()
        while select.select([self.fd], [], [], quiet_s)[0]:
            try:
                if not os.read(self.fd, 65536):
                    break
            except BlockingIOError:
                break

    def request(self, cmd, payload=b'', timeout=TIMEOUT_S):
        """Returns (payload, seconds) or (None, seconds) on timeout, checksum error or error reply."""
        os.write(self.fd, frame(cmd, payload))
        start = time.monotonic()
        while True:
            reply = self._parse(cmd)
            if reply is not None:
                return (reply if reply is not False else None), time.monotonic() - start
            left = timeout - (time.monotonic() - start)
            if left <= 0 or not select.select([self.fd], [], [], left)[0]:
                return None, time.monotonic() - start
            try:
                self.buf += os.read(self.fd, 65536)
            except BlockingIOError:
                pass

    def _parse(self, cmd):
        """None: need more bytes. False: bad frame. bytes: payload of a good reply to cmd."""
        b = self.buf
        while True:
            i = b.find(b'$M')
            if i < 0:
                del b[:max(0, len(b) - 1)]
                return None
            if i:
                del b[:i]
            if len(b) < 5:
                return None
            direction, size, code = b[2], b[3], b[4]
            head = 5
            if size == 255:                                   # jumbo frame: real size follows
                if len(b) < 7:
                    return None
                size = b[5] | b[6] << 8
                head = 7
            if len(b) < head + size + 1:
                return None
            check = 0
            for x in b[3:head + size]:
                check ^= x
            good = check == b[head + size]
            payload = bytes(b[head:head + size])
            del b[:head + size + 1]
            if direction == ord('>') and code == cmd:
                return payload if good else False
            if direction == ord('!') and code == cmd:
                return False
            # a reply to something else: skip it and look at the next frame


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('device')
    ap.add_argument('--out', help='write the flash contents to this file')
    ap.add_argument('--resume', action='store_true', help='continue --out from its current size')
    ap.add_argument('--compare', help='compare the flash contents with this file instead of writing')
    ap.add_argument('--start', type=int, default=0)
    ap.add_argument('--end', type=int, help='stop at this address (default: used size)')
    args = ap.parse_args()

    def say(*a):
        print(time.strftime('%H:%M:%S'), *a, flush=True)

    link = Link(open_port(args.device))
    link.drain(0.3)
    api, _ = link.request(MSP_API_VERSION)
    if api is None:
        sys.exit('no reply to MSP_API_VERSION: wrong port, or another program holds it')
    summary, _ = link.request(MSP_DATAFLASH_SUMMARY)
    flags, sectors, total, used = struct.unpack('<BIII', summary[:13])
    say(f'MSP API {api[1]}.{api[2]}; flash ready={bool(flags & 1)} total={total} used={used} ({used / 1048576:.1f} MiB)')

    reference = open(args.compare, 'rb').read() if args.compare else None
    if reference is not None:
        say(f'comparing with {args.compare} ({len(reference)} bytes); sizes {"match" if len(reference) == used else "DIFFER"}')
    out, addr = None, args.start
    if args.out:
        if args.resume and os.path.exists(args.out):
            addr = os.path.getsize(args.out)
            say(f'resuming at {addr}')
        out = open(args.out, 'ab' if args.resume else 'wb')
    end = min(args.end or used, used)

    stats = dict(timeouts=0, bad=0, wrong_address=0, mismatched_bytes=0, slow=0, requests=0)
    window, window_start, window_addr, began = [], time.monotonic(), addr, time.monotonic()
    while addr < end:
        want = min(BLOCK, end - addr)
        reply, took = link.request(MSP_DATAFLASH_READ, struct.pack('<IHB', addr, want, 0))
        stats['requests'] += 1
        if reply is None:
            stats['timeouts' if took >= TIMEOUT_S else 'bad'] += 1
            say(f'NO GOOD REPLY at {addr} after {took:.2f} s, retrying')
            link.drain(0.2)
            continue
        got_addr, n, compression = struct.unpack('<IHB', reply[:7])
        if got_addr != addr or compression != 0:
            stats['wrong_address'] += 1
            say(f'reply for address {got_addr} (compression {compression}) while asking for {addr}, retrying')
            link.drain(0.2)
            continue
        if n == 0:
            say(f'flight controller returned no data at {addr}')
            break
        data = reply[7:7 + n]
        if took > SLOW_S:
            stats['slow'] += 1
            say(f'slow reply at {addr}: {took:.2f} s')
        if reference is not None:
            ref = reference[addr:addr + n]
            if ref != data:
                bad = sum(1 for x, y in zip(ref, data) if x != y) + abs(len(ref) - len(data))
                stats['mismatched_bytes'] += bad
                say(f'CONTENT DIFFERS at {addr}: {bad} of {n} bytes')
        if out:
            out.write(data)
        window.append(took)
        addr += n
        if addr - window_addr >= 4 * 1048576 or addr >= end:
            span = time.monotonic() - window_start
            window.sort()
            say(f'{addr / 1048576:7.1f} MiB  {(addr - window_addr) / span / 1024:6.1f} kB/s  reply median {1000 * window[len(window) // 2]:.1f} ms  '
                f'p99 {1000 * window[int(len(window) * 0.99)]:.1f} ms  max {1000 * window[-1]:.1f} ms  ' + ' '.join(f'{k}={v}' for k, v in stats.items()))
            window, window_start, window_addr = [], time.monotonic(), addr
    if out:
        out.close()
    say(f'done: {addr - args.start} bytes in {time.monotonic() - began:.0f} s; ' + ' '.join(f'{k}={v}' for k, v in stats.items()))


if __name__ == '__main__':
    main()
