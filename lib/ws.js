"use strict";
/**
 * Cliente WebSocket minimo (RFC 6455) sobre net.Socket.
 *
 * Existe porque o Node embutido no app do Stream Deck e o 20.x, que ainda nao expoe
 * `WebSocket` global sem flag. Escrever o handshake e o enquadramento a mao mantem o
 * plugin com ZERO node_modules, o que importa duas vezes aqui: a pasta vive no Google
 * Drive (sync de milhares de arquivos) e o plugin precisa rodar igual no macOS e no
 * Windows.
 *
 * Escopo deliberadamente estreito: conexao local, sem TLS, texto JSON. Nao e um cliente
 * WebSocket de uso geral.
 */

const net = require("net");
const crypto = require("crypto");

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

class MiniWebSocket {
  constructor(port, host = "127.0.0.1") {
    this.port = port;
    this.host = host;
    this.handlers = { open: [], message: [], close: [], error: [] };
    this.buffer = Buffer.alloc(0);
    this.handshakeDone = false;
    this.fragments = [];
    this.fragmentOpcode = null;
    this.closed = false;

    this.key = crypto.randomBytes(16).toString("base64");
    this.expectedAccept = crypto
      .createHash("sha1")
      .update(this.key + GUID)
      .digest("base64");

    this.socket = net.connect({ port, host }, () => this._sendHandshake());
    this.socket.on("data", (chunk) => this._onData(chunk));
    this.socket.on("error", (err) => this._emit("error", err));
    this.socket.on("close", () => {
      if (!this.closed) {
        this.closed = true;
        this._emit("close");
      }
    });
  }

  on(event, fn) {
    if (this.handlers[event]) this.handlers[event].push(fn);
    return this;
  }

  _emit(event, arg) {
    for (const fn of this.handlers[event] || []) {
      try {
        fn(arg);
      } catch (err) {
        if (event !== "error") this._emit("error", err);
      }
    }
  }

  _sendHandshake() {
    this.socket.write(
      [
        "GET / HTTP/1.1",
        `Host: ${this.host}:${this.port}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${this.key}`,
        "Sec-WebSocket-Version: 13",
        "",
        "",
      ].join("\r\n")
    );
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    if (!this.handshakeDone) {
      const end = this.buffer.indexOf("\r\n\r\n");
      if (end === -1) return; // cabecalho ainda incompleto
      const header = this.buffer.subarray(0, end).toString("latin1");
      this.buffer = this.buffer.subarray(end + 4);

      if (!/^HTTP\/1\.1 101/i.test(header)) {
        this._emit("error", new Error(`handshake recusado: ${header.split("\r\n")[0]}`));
        return this.close();
      }
      const accept = /sec-websocket-accept:\s*(\S+)/i.exec(header);
      if (!accept || accept[1] !== this.expectedAccept) {
        this._emit("error", new Error("Sec-WebSocket-Accept invalido"));
        return this.close();
      }
      this.handshakeDone = true;
      this._emit("open");
    }

    this._drainFrames();
  }

  _drainFrames() {
    for (;;) {
      const frame = this._readFrame();
      if (!frame) return;

      const { opcode, fin, payload } = frame;

      if (opcode === 0x8) {
        // close
        this._writeFrame(0x8, Buffer.alloc(0));
        return this.close();
      }
      if (opcode === 0x9) {
        this._writeFrame(0xa, payload); // pong
        continue;
      }
      if (opcode === 0xa) continue; // pong recebido, ignora

      if (opcode === 0x0) {
        this.fragments.push(payload);
      } else {
        this.fragments = [payload];
        this.fragmentOpcode = opcode;
      }

      if (fin) {
        const full = Buffer.concat(this.fragments);
        this.fragments = [];
        if (this.fragmentOpcode === 0x1) this._emit("message", full.toString("utf8"));
        this.fragmentOpcode = null;
      }
    }
  }

  /** Retorna um frame completo ou null se ainda faltam bytes no buffer. */
  _readFrame() {
    const buf = this.buffer;
    if (buf.length < 2) return null;

    const fin = (buf[0] & 0x80) !== 0;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let offset = 2;

    if (len === 126) {
      if (buf.length < offset + 2) return null;
      len = buf.readUInt16BE(offset);
      offset += 2;
    } else if (len === 127) {
      if (buf.length < offset + 8) return null;
      const big = buf.readBigUInt64BE(offset);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
        this._emit("error", new Error("frame gigante demais"));
        this.close();
        return null;
      }
      len = Number(big);
      offset += 8;
    }

    let maskKey = null;
    if (masked) {
      if (buf.length < offset + 4) return null;
      maskKey = buf.subarray(offset, offset + 4);
      offset += 4;
    }

    if (buf.length < offset + len) return null;

    let payload = Buffer.from(buf.subarray(offset, offset + len));
    if (maskKey) {
      for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];
    }
    this.buffer = buf.subarray(offset + len);
    return { fin, opcode, payload };
  }

  _writeFrame(opcode, payload) {
    if (this.closed || this.socket.destroyed) return;

    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[1] = 0x80 | len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode; // FIN + opcode

    // cliente SEMPRE mascara (RFC 6455 5.3)
    const mask = crypto.randomBytes(4);
    const masked = Buffer.from(payload);
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];

    this.socket.write(Buffer.concat([header, mask, masked]));
  }

  send(text) {
    this._writeFrame(0x1, Buffer.from(text, "utf8"));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket.destroy();
    } catch {}
    this._emit("close");
  }
}

module.exports = { MiniWebSocket };
