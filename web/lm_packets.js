export const LM_BLE_MAGIC = 0x4c42;
export const LM_BLE_VERSION = 1;
export const LM_BLE_TYPE_GPS = 1;
export const LM_BLE_TYPE_STATUS = 2;
export const LM_BLE_TYPE_TEXT = 3;
export const LM_BLE_TYPE_TEXT_ACK = 4;
export const LM_GPS_FLAG_VALID = 0x01;
export const LM_TEXT_FLAG_BROADCAST = 0x01;
export const LM_TEXT_ACK_RECEIVED = 0;
export const LM_TEXT_ACK_ERROR = 1;
export const LM_TEXT_MAX_BYTES = 180;
export const LM_TEXT_PACKET_BYTES = 232;
export const LM_TEXT_ACK_BYTES = 48;
export const LM_GPS_PACKET_BYTES = 28;
export const LM_STATUS_PACKET_BYTES = 56;

export const LM_RADIO_MAGIC = 0x4c4d;
export const LM_RADIO_VERSION = 2;
export const LM_RADIO_TYPE_PEER_SNAPSHOT = 2;
export const LM_NODE_MAX = 4;
export const LM_PEER_ENTRY_BYTES = 56;
export const LM_PEER_SNAPSHOT_HEADER_BYTES = 12;
export const LM_PEER_SNAPSHOT_BYTES =
  LM_PEER_SNAPSHOT_HEADER_BYTES + LM_NODE_MAX * LM_PEER_ENTRY_BYTES;

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: false });

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function uint8(value) {
  return clamp(Number(value) || 0, 0, 255);
}

function uint16(value) {
  return clamp(Math.trunc(Number(value) || 0), 0, 0xffff);
}

function uint32(value) {
  return Math.trunc(Number(value) || 0) >>> 0;
}

function int32(value) {
  return Math.trunc(Number(value) || 0) | 0;
}

function viewOf(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function readFixedString(view, offset, length) {
  const bytes = new Uint8Array(view.buffer, view.byteOffset + offset, length);
  let end = bytes.indexOf(0);
  if (end < 0) {
    end = bytes.length;
  }
  return decoder.decode(bytes.subarray(0, end));
}

function writeFixedString(view, offset, length, value) {
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  const encoded = encoder.encode(String(value ?? ''));
  const count = Math.min(encoded.length, length);
  bytes.fill(0, offset, offset + length);
  bytes.set(encoded.subarray(0, count), offset);
}

export function utf8Length(value) {
  return encoder.encode(String(value ?? '')).length;
}

export function randomMsgId() {
  const buffer = new Uint32Array(1);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(buffer);
  } else {
    buffer[0] = Math.floor(Math.random() * 0xffffffff);
  }
  return buffer[0] === 0 ? 1 : buffer[0] >>> 0;
}

export function nowSeconds() {
  return Math.floor(Date.now() / 1000) >>> 0;
}

export function encodeGpsPacket(packet) {
  const bytes = new Uint8Array(LM_GPS_PACKET_BYTES);
  const view = viewOf(bytes);
  view.setUint16(0, LM_BLE_MAGIC, true);
  view.setUint8(2, LM_BLE_VERSION);
  view.setUint8(3, LM_BLE_TYPE_GPS);
  view.setUint32(4, uint32(packet.seq), true);
  view.setFloat32(8, Number(packet.lat) || 0, true);
  view.setFloat32(12, Number(packet.lon) || 0, true);
  view.setFloat32(16, Number(packet.accuracy) || 0, true);
  view.setInt32(20, int32(packet.altitudeM), true);
  view.setUint16(24, uint16(packet.fixAgeMs), true);
  view.setUint8(26, uint8(packet.satellites));
  view.setUint8(27, packet.valid === false ? 0 : LM_GPS_FLAG_VALID);
  return bytes;
}

export function decodeGpsPacket(value) {
  const bytes = toBytes(value);
  if (!bytes || bytes.length < LM_GPS_PACKET_BYTES) {
    return null;
  }
  const view = viewOf(bytes);
  if (
    view.getUint16(0, true) !== LM_BLE_MAGIC ||
    view.getUint8(2) !== LM_BLE_VERSION ||
    view.getUint8(3) !== LM_BLE_TYPE_GPS
  ) {
    return null;
  }
  return {
    seq: view.getUint32(4, true),
    lat: view.getFloat32(8, true),
    lon: view.getFloat32(12, true),
    accuracy: view.getFloat32(16, true),
    altitudeM: view.getInt32(20, true),
    fixAgeMs: view.getUint16(24, true),
    satellites: view.getUint8(26),
    valid: (view.getUint8(27) & LM_GPS_FLAG_VALID) !== 0,
  };
}

export function decodeStatus(value) {
  const bytes = toBytes(value);
  if (!bytes || bytes.length < LM_STATUS_PACKET_BYTES) {
    return null;
  }
  const view = viewOf(bytes);
  if (
    view.getUint16(0, true) !== LM_BLE_MAGIC ||
    view.getUint8(2) !== LM_BLE_VERSION ||
    view.getUint8(3) !== LM_BLE_TYPE_STATUS
  ) {
    return null;
  }
  return {
    nodeId: readFixedString(view, 4, 17),
    hasFix: view.getUint8(21) !== 0,
    gpsSource: view.getUint8(22),
    satellites: view.getUint8(23),
    peerCount: view.getUint8(24),
    lat: view.getFloat32(28, true),
    lon: view.getFloat32(32, true),
    accuracy: view.getFloat32(36, true),
    altitudeM: view.getInt32(40, true),
    fixAgeMs: view.getUint16(44, true),
    bootId: view.getUint16(46, true),
    uptimeS: view.getUint32(48, true),
    seq: view.getUint32(52, true),
  };
}

export function encodeTextPacket(packet) {
  const bytes = new Uint8Array(LM_TEXT_PACKET_BYTES);
  const view = viewOf(bytes);
  const encoded = encoder.encode(String(packet.text ?? ''));
  const textLen = Math.min(encoded.length, LM_TEXT_MAX_BYTES);
  view.setUint16(0, LM_BLE_MAGIC, true);
  view.setUint8(2, LM_BLE_VERSION);
  view.setUint8(3, LM_BLE_TYPE_TEXT);
  view.setUint32(4, uint32(packet.msgId), true);
  view.setUint32(8, uint32(packet.sentAt), true);
  writeFixedString(view, 12, 17, packet.from);
  writeFixedString(view, 29, 17, packet.to);
  view.setUint16(46, uint16(packet.fromBootId), true);
  view.setUint8(48, uint8(packet.ttl));
  view.setUint8(49, uint8(packet.flags));
  view.setUint8(50, textLen);
  view.setUint8(51, 0);
  bytes.set(encoded.subarray(0, textLen), 52);
  return bytes;
}

export function decodeText(value) {
  const bytes = toBytes(value);
  if (!bytes || bytes.length < 52) {
    return null;
  }
  const view = viewOf(bytes);
  if (
    view.getUint16(0, true) !== LM_BLE_MAGIC ||
    view.getUint8(2) !== LM_BLE_VERSION ||
    view.getUint8(3) !== LM_BLE_TYPE_TEXT
  ) {
    return null;
  }
  const textLen = view.getUint8(50);
  if (textLen === 0 || textLen > LM_TEXT_MAX_BYTES || bytes.length < 52 + textLen) {
    return null;
  }
  const flags = view.getUint8(49);
  const to = readFixedString(view, 29, 17);
  return {
    msgId: view.getUint32(4, true),
    sentAt: view.getUint32(8, true),
    from: readFixedString(view, 12, 17),
    to,
    fromBootId: view.getUint16(46, true),
    ttl: view.getUint8(48),
    flags,
    text: decoder.decode(bytes.subarray(52, 52 + textLen)),
    broadcast: (flags & LM_TEXT_FLAG_BROADCAST) !== 0 || to === '*',
  };
}

export function decodeTextAck(value) {
  const bytes = toBytes(value);
  if (!bytes || bytes.length < LM_TEXT_ACK_BYTES) {
    return null;
  }
  const view = viewOf(bytes);
  if (
    view.getUint16(0, true) !== LM_BLE_MAGIC ||
    view.getUint8(2) !== LM_BLE_VERSION ||
    view.getUint8(3) !== LM_BLE_TYPE_TEXT_ACK
  ) {
    return null;
  }
  const status = view.getUint8(44);
  return {
    msgId: view.getUint32(4, true),
    from: readFixedString(view, 8, 17),
    to: readFixedString(view, 25, 17),
    fromBootId: view.getUint16(42, true),
    status,
    isError: status === LM_TEXT_ACK_ERROR,
  };
}

export function decodePeerSnapshot(value) {
  const bytes = toBytes(value);
  if (!bytes || bytes.length < LM_PEER_SNAPSHOT_HEADER_BYTES) {
    return null;
  }
  const view = viewOf(bytes);
  if (
    view.getUint16(0, true) !== LM_RADIO_MAGIC ||
    view.getUint8(2) !== LM_RADIO_VERSION ||
    view.getUint8(3) !== LM_RADIO_TYPE_PEER_SNAPSHOT
  ) {
    return null;
  }
  const count = clamp(view.getUint8(4), 0, LM_NODE_MAX);
  if (bytes.length < LM_PEER_SNAPSHOT_HEADER_BYTES + count * LM_PEER_ENTRY_BYTES) {
    return null;
  }
  const peers = [];
  for (let index = 0; index < count; index += 1) {
    const offset = LM_PEER_SNAPSHOT_HEADER_BYTES + index * LM_PEER_ENTRY_BYTES;
    peers.push({
      id: readFixedString(view, offset, 17),
      hasFix: view.getUint8(offset + 17) !== 0,
      satellites: view.getUint8(offset + 18),
      gpsSource: view.getUint8(offset + 19),
      lat: view.getFloat32(offset + 24, true),
      lon: view.getFloat32(offset + 28, true),
      accuracy: view.getFloat32(offset + 32, true),
      altitudeM: view.getInt32(offset + 36, true),
      uptimeS: view.getUint32(offset + 40, true),
      seq: view.getUint32(offset + 44, true),
      bootId: view.getUint16(offset + 48, true),
      fixAgeMs: view.getUint16(offset + 50, true),
      ageS: view.getUint16(offset + 52, true),
      rssi: view.getInt8(offset + 54),
    });
  }
  return {
    hubUptimeS: view.getUint32(8, true),
    peers,
  };
}

export function sourceName(source) {
  if (source === 1) {
    return 'ESP32';
  }
  if (source === 2) {
    return 'Teléfono';
  }
  return 'Sin datos';
}

function toBytes(value) {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (Array.isArray(value)) {
    return Uint8Array.from(value);
  }
  return null;
}
