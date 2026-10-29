import { createHash, randomBytes } from 'node:crypto';
import { connect, type Socket } from 'node:net';

/** A pull-based byte reader over a stream of chunks. */
class ByteQueue {
  private chunks: Buffer[] = [];
  private length = 0;
  private waiting?: () => void;
  private ended = false;
  push(chunk: Buffer): void { this.chunks.push(chunk); this.length += chunk.length; this.waiting?.(); }
  end(): void { this.ended = true; this.waiting?.(); }
  async take(count: number): Promise<Buffer> {
    while (this.length < count) {
      if (this.ended) throw new Error('operator_channel_closed');
      await new Promise<void>(resolve => { this.waiting = resolve; });
    }
    const all = Buffer.concat(this.chunks);
    this.chunks = all.length > count ? [all.subarray(count)] : [];
    this.length = all.length - count;
    return all.subarray(0, count);
  }
}

export type Screen = { width: number; height: number; name: string; pixels: Buffer };
export type OperatorChannel = {
  /** The current framebuffer as 32-bit BGRX pixels. */
  screen: () => Promise<Screen>;
  pointer: (x: number, y: number, buttons?: number) => void;
  key: (keysym: number, down: boolean) => void;
  type: (text: string) => Promise<void>;
  press: (keysym: number) => Promise<void>;
  closed: Promise<void>;
  close: () => void;
};

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
export const KEYSYMS = { Tab: 0xff09, Enter: 0xff0d, Escape: 0xff1b } as const;

/**
 * A scripted human operator: opens the takeover page's websocket (the same /websockify channel noVNC uses),
 * speaks RFB over it, and sends real pointer and key events. It is a test client, not production code.
 */
export async function connectOperator(port: number, headers: Record<string, string>): Promise<OperatorChannel> {
  const socket: Socket = connect(port, '127.0.0.1');
  await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  const key = randomBytes(16).toString('base64');
  const upgrade = ['GET /websockify HTTP/1.1', `Host: 127.0.0.1:${port}`, `Origin: http://127.0.0.1:${port}`, 'Upgrade: websocket', 'Connection: Upgrade',
    `Sec-WebSocket-Key: ${key}`, 'Sec-WebSocket-Version: 13', 'Sec-WebSocket-Protocol: binary', ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`), '', ''];
  socket.write(upgrade.join('\r\n'));
  const bytes = new ByteQueue();
  let head = Buffer.alloc(0), upgraded = false, frame = Buffer.alloc(0);
  const closed = new Promise<void>(resolve => socket.once('close', () => { bytes.end(); resolve(); }));
  const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  const handshake = new Promise<void>((resolve, reject) => {
    socket.on('error', reject);
    socket.on('data', (chunk: Buffer) => {
      if (!upgraded) {
        head = Buffer.concat([head, chunk]);
        const end = head.indexOf('\r\n\r\n');
        if (end < 0) return;
        const text = head.subarray(0, end).toString('latin1');
        if (!/^HTTP\/1\.1 101/.test(text) || !text.includes(accept)) { reject(new Error(`operator_upgrade_refused: ${text.split('\r\n')[0]}`)); socket.destroy(); return; }
        upgraded = true; resolve();
        chunk = head.subarray(end + 4);
      }
      frame = Buffer.concat([frame, chunk]);
      for (;;) {
        if (frame.length < 2) return;
        let length = frame[1]! & 0x7f, offset = 2;
        if (length === 126) { if (frame.length < 4) return; length = frame.readUInt16BE(2); offset = 4; }
        else if (length === 127) { if (frame.length < 10) return; length = Number(frame.readBigUInt64BE(2)); offset = 10; }
        if (frame.length < offset + length) return;
        const opcode = frame[0]! & 0x0f;
        if (opcode === 2 || opcode === 0) bytes.push(Buffer.from(frame.subarray(offset, offset + length)));
        if (opcode === 8) socket.end();
        frame = frame.subarray(offset + length);
      }
    });
    socket.once('close', () => reject(new Error('operator_channel_closed')));
  });
  const send = (payload: Buffer) => {
    const mask = randomBytes(4);
    const header = payload.length < 126 ? Buffer.from([0x82, 0x80 | payload.length]) : Buffer.from([0x82, 0x80 | 126, payload.length >> 8, payload.length & 0xff]);
    const masked = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]!));
    socket.write(Buffer.concat([header, mask, masked]));
  };
  await handshake;
  // RFB 3.8 handshake, security type None (the channel is loopback-only behind the takeover page's own authentication).
  const version = (await bytes.take(12)).toString('latin1');
  if (!/^RFB 003\.\d{3}\n$/.test(version)) throw new Error('operator_rfb_version');
  send(Buffer.from('RFB 003.008\n'));
  const types = await bytes.take((await bytes.take(1))[0]!);
  if (!types.includes(1)) throw new Error('operator_rfb_security');
  send(Buffer.from([1]));
  if ((await bytes.take(4)).readUInt32BE(0) !== 0) throw new Error('operator_rfb_refused');
  send(Buffer.from([0]));
  const init = await bytes.take(24);
  const width = init.readUInt16BE(0), height = init.readUInt16BE(2);
  const name = (await bytes.take(init.readUInt32BE(20))).toString('utf8');
  // Ask for 32-bit true-colour so a Raw rectangle is width*height*4 bytes (B,G,R,x little-endian).
  send(Buffer.from([0, 0, 0, 0, 32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0]));
  send(Buffer.from([2, 0, 0, 1, 0, 0, 0, 0]));
  // Like a real viewer: keep requesting incremental updates and apply every rectangle to one framebuffer.
  const pixels = Buffer.alloc(width * height * 4);
  const request = (incremental: number) => { const update = Buffer.alloc(10); update[0] = 3; update[1] = incremental; update.writeUInt16BE(width, 6); update.writeUInt16BE(height, 8); send(update); };
  void (async () => {
    try {
      for (;;) {
        const type = (await bytes.take(1))[0]!;
        if (type === 0) {
          const header = await bytes.take(3);
          for (let rect = 0; rect < header.readUInt16BE(1); rect++) {
            const geometry = await bytes.take(12);
            const x = geometry.readUInt16BE(0), y = geometry.readUInt16BE(2), w = geometry.readUInt16BE(4), h = geometry.readUInt16BE(6);
            if (geometry.readInt32BE(8) !== 0) throw new Error('operator_rfb_encoding');
            const raw = await bytes.take(w * h * 4);
            for (let row = 0; row < h; row++) raw.copy(pixels, ((y + row) * width + x) * 4, row * w * 4, (row + 1) * w * 4);
          }
          request(1);
        } else if (type === 2) continue;
        else if (type === 3) await bytes.take((await bytes.take(7)).readUInt32BE(3));
        else throw new Error('operator_rfb_message');
      }
    } catch { /* channel closed */ }
  })();
  request(0);
  return {
    closed,
    screen: async () => { request(0); await pause(500); return { width, height, name, pixels: Buffer.from(pixels) }; },
    pointer: (x, y, buttons = 0) => { const message = Buffer.alloc(6); message[0] = 5; message[1] = buttons; message.writeUInt16BE(x, 2); message.writeUInt16BE(y, 4); send(message); },
    key: (keysym, down) => send(keyMessage(keysym, down)),
    press: async keysym => { send(keyMessage(keysym, true)); await pause(30); send(keyMessage(keysym, false)); await pause(30); },
    type: async text => { for (const character of text) { const keysym = character.charCodeAt(0); send(keyMessage(keysym, true)); await pause(20); send(keyMessage(keysym, false)); await pause(20); } },
    close: () => socket.destroy(),
  };
}

function keyMessage(keysym: number, down: boolean): Buffer {
  const message = Buffer.alloc(8); message[0] = 4; message[1] = down ? 1 : 0; message.writeUInt32BE(keysym, 4); return message;
}
