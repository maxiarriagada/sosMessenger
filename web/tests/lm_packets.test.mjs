import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LM_BLE_MAGIC,
  LM_BLE_TYPE_GPS,
  LM_BLE_TYPE_STATUS,
  LM_BLE_TYPE_TEXT,
  LM_BLE_TYPE_TEXT_ACK,
  LM_BLE_VERSION,
  LM_GPS_FLAG_VALID,
  LM_PEER_SNAPSHOT_HEADER_BYTES,
  LM_RADIO_MAGIC,
  LM_RADIO_TYPE_PEER_SNAPSHOT,
  LM_RADIO_VERSION,
  LM_TEXT_FLAG_BROADCAST,
  decodeGpsPacket,
  decodePeerSnapshot,
  decodeStatus,
  decodeText,
  decodeTextAck,
  encodeGpsPacket,
  encodeTextPacket,
  randomMsgId,
  utf8Length,
} from '../lm_packets.js';

const encoder = new TextEncoder();

function writeFixed(view, offset, length, value) {
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  const encoded = encoder.encode(value);
  bytes.fill(0, offset, offset + length);
  bytes.set(encoded.subarray(0, Math.min(encoded.length, length)), offset);
}

function close(actual, expected, epsilon = 1e-5) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected}`);
}

test('GPS packet roundtrip', () => {
  const bytes = encodeGpsPacket({
    seq: 42,
    lat: 4.60971,
    lon: -74.08175,
    accuracy: 12.5,
    altitudeM: 2600,
    fixAgeMs: 1500,
    satellites: 7,
    valid: true,
  });
  assert.equal(bytes.length, 28);
  const packet = decodeGpsPacket(bytes);
  assert.equal(packet.seq, 42);
  close(packet.lat, 4.60971);
  close(packet.lon, -74.08175);
  close(packet.accuracy, 12.5);
  assert.equal(packet.altitudeM, 2600);
  assert.equal(packet.fixAgeMs, 1500);
  assert.equal(packet.satellites, 7);
  assert.equal(packet.valid, true);
});

test('GPS invalid flag', () => {
  const packet = decodeGpsPacket(
    encodeGpsPacket({
      seq: 0,
      lat: 0,
      lon: 0,
      accuracy: 0,
      altitudeM: 0,
      fixAgeMs: 0,
      satellites: 0,
      valid: false,
    }),
  );
  assert.equal(packet.valid, false);
});

test('text packet roundtrip with UTF-8 and broadcast', () => {
  const bytes = encodeTextPacket({
    msgId: 0xdeadbeef,
    sentAt: 123456,
    from: 'A608',
    to: '*',
    fromBootId: 25701,
    ttl: 2,
    flags: LM_TEXT_FLAG_BROADCAST,
    text: 'hola ñ andino',
  });
  assert.equal(bytes.length, 232);
  const packet = decodeText(bytes);
  assert.equal(packet.msgId, 0xdeadbeef);
  assert.equal(packet.sentAt, 123456);
  assert.equal(packet.from, 'A608');
  assert.equal(packet.to, '*');
  assert.equal(packet.fromBootId, 25701);
  assert.equal(packet.ttl, 2);
  assert.equal(packet.flags, LM_TEXT_FLAG_BROADCAST);
  assert.equal(packet.broadcast, true);
  assert.equal(packet.text, 'hola ñ andino');
});

test('text packet truncates to 180 UTF-8 bytes', () => {
  const text = 'á'.repeat(200);
  const packet = decodeText(
    encodeTextPacket({
      msgId: 1,
      sentAt: 1,
      from: '5494',
      to: 'A608',
      fromBootId: 1,
      ttl: 0,
      flags: 0,
      text,
    }),
  );
  assert.equal(utf8Length(packet.text), 180);
  assert.equal(packet.broadcast, false);
});

test('text packet rejects empty payload', () => {
  const bytes = encodeTextPacket({
    msgId: 1,
    sentAt: 1,
    from: '5494',
    to: '*',
    fromBootId: 1,
    ttl: 0,
    flags: 0,
    text: '',
  });
  assert.equal(decodeText(bytes), null);
});

test('text ACK decode', () => {
  const bytes = new Uint8Array(48);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, LM_BLE_MAGIC, true);
  view.setUint8(2, LM_BLE_VERSION);
  view.setUint8(3, LM_BLE_TYPE_TEXT_ACK);
  view.setUint32(4, 4055940553, true);
  writeFixed(view, 8, 17, '5494');
  writeFixed(view, 25, 17, 'A608');
  view.setUint16(42, 25701, true);
  view.setUint8(44, 0);
  const ack = decodeTextAck(bytes);
  assert.equal(ack.msgId, 4055940553);
  assert.equal(ack.from, '5494');
  assert.equal(ack.to, 'A608');
  assert.equal(ack.fromBootId, 25701);
  assert.equal(ack.status, 0);
  assert.equal(ack.isError, false);
  view.setUint8(44, 1);
  assert.equal(decodeTextAck(bytes).isError, true);
});

test('status decode', () => {
  const bytes = new Uint8Array(56);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, LM_BLE_MAGIC, true);
  view.setUint8(2, LM_BLE_VERSION);
  view.setUint8(3, LM_BLE_TYPE_STATUS);
  writeFixed(view, 4, 17, '5494');
  view.setUint8(21, 1);
  view.setUint8(22, 2);
  view.setUint8(23, 9);
  view.setUint8(24, 1);
  view.setFloat32(28, 4.60971, true);
  view.setFloat32(32, -74.08175, true);
  view.setFloat32(36, 8.5, true);
  view.setInt32(40, 2600, true);
  view.setUint16(44, 3000, true);
  view.setUint16(46, 25701, true);
  view.setUint32(48, 3600, true);
  view.setUint32(52, 99, true);
  const status = decodeStatus(bytes);
  assert.equal(status.nodeId, '5494');
  assert.equal(status.hasFix, true);
  assert.equal(status.gpsSource, 2);
  assert.equal(status.satellites, 9);
  assert.equal(status.peerCount, 1);
  close(status.lat, 4.60971);
  close(status.lon, -74.08175);
  close(status.accuracy, 8.5);
  assert.equal(status.altitudeM, 2600);
  assert.equal(status.fixAgeMs, 3000);
  assert.equal(status.bootId, 25701);
  assert.equal(status.uptimeS, 3600);
  assert.equal(status.seq, 99);
});

test('peer snapshot decode', () => {
  const bytes = new Uint8Array(LM_PEER_SNAPSHOT_HEADER_BYTES + 56);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, LM_RADIO_MAGIC, true);
  view.setUint8(2, LM_RADIO_VERSION);
  view.setUint8(3, LM_RADIO_TYPE_PEER_SNAPSHOT);
  view.setUint8(4, 1);
  view.setUint32(8, 7200, true);
  const offset = LM_PEER_SNAPSHOT_HEADER_BYTES;
  writeFixed(view, offset, 17, 'A608');
  view.setUint8(offset + 17, 1);
  view.setUint8(offset + 18, 6);
  view.setUint8(offset + 19, 1);
  view.setFloat32(offset + 24, 4.6, true);
  view.setFloat32(offset + 28, -74.1, true);
  view.setFloat32(offset + 32, 15.5, true);
  view.setInt32(offset + 36, 2550, true);
  view.setUint32(offset + 40, 1200, true);
  view.setUint32(offset + 44, 77, true);
  view.setUint16(offset + 48, 25701, true);
  view.setUint16(offset + 50, 2000, true);
  view.setUint16(offset + 52, 12, true);
  view.setInt8(offset + 54, -67);
  const snapshot = decodePeerSnapshot(bytes);
  assert.equal(snapshot.hubUptimeS, 7200);
  assert.equal(snapshot.peers.length, 1);
  const peer = snapshot.peers[0];
  assert.equal(peer.id, 'A608');
  assert.equal(peer.hasFix, true);
  assert.equal(peer.satellites, 6);
  assert.equal(peer.gpsSource, 1);
  close(peer.lat, 4.6);
  close(peer.lon, -74.1);
  close(peer.accuracy, 15.5);
  assert.equal(peer.altitudeM, 2550);
  assert.equal(peer.uptimeS, 1200);
  assert.equal(peer.seq, 77);
  assert.equal(peer.bootId, 25701);
  assert.equal(peer.fixAgeMs, 2000);
  assert.equal(peer.ageS, 12);
  assert.equal(peer.rssi, -67);
});

test('invalid magic is rejected', () => {
  const bytes = new Uint8Array(56);
  assert.equal(decodeStatus(bytes), null);
  assert.equal(decodeText(bytes), null);
  assert.equal(decodeTextAck(bytes), null);
  assert.equal(decodePeerSnapshot(bytes), null);
  assert.equal(decodeGpsPacket(bytes), null);
  assert.equal(decodeStatus(new Uint8Array(10)), null);
});

test('random message id is nonzero', () => {
  for (let index = 0; index < 100; index += 1) {
    assert.notEqual(randomMsgId(), 0);
  }
});

test('constants match firmware contract', () => {
  assert.equal(LM_BLE_MAGIC, 0x4c42);
  assert.equal(LM_RADIO_MAGIC, 0x4c4d);
  assert.equal(LM_BLE_VERSION, 1);
  assert.equal(LM_RADIO_VERSION, 2);
  assert.equal(LM_BLE_TYPE_GPS, 1);
  assert.equal(LM_BLE_TYPE_STATUS, 2);
  assert.equal(LM_BLE_TYPE_TEXT, 3);
  assert.equal(LM_BLE_TYPE_TEXT_ACK, 4);
  assert.equal(LM_GPS_FLAG_VALID, 1);
  assert.equal(LM_TEXT_FLAG_BROADCAST, 1);
});
