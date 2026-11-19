import test from 'node:test';
import assert from 'node:assert/strict';
import { LmBle, LM_BLE_UUIDS } from '../lm_ble.js';
import {
  LM_BLE_MAGIC,
  LM_BLE_TYPE_STATUS,
  LM_BLE_TYPE_TEXT_ACK,
  LM_BLE_VERSION,
  LM_PEER_SNAPSHOT_HEADER_BYTES,
  LM_RADIO_MAGIC,
  LM_RADIO_TYPE_PEER_SNAPSHOT,
  LM_RADIO_VERSION,
  decodeGpsPacket,
  decodeText,
  encodeGpsPacket,
  encodeTextPacket,
} from '../lm_packets.js';

const encoder = new TextEncoder();

function writeFixed(view, offset, length, value) {
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  const encoded = encoder.encode(value);
  bytes.fill(0, offset, offset + length);
  bytes.set(encoded.subarray(0, Math.min(encoded.length, length)), offset);
}

function statusBytes(overrides = {}) {
  const bytes = new Uint8Array(56);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, LM_BLE_MAGIC, true);
  view.setUint8(2, LM_BLE_VERSION);
  view.setUint8(3, LM_BLE_TYPE_STATUS);
  writeFixed(view, 4, 17, overrides.nodeId ?? '5494');
  view.setUint8(21, overrides.hasFix ?? 1);
  view.setUint8(22, overrides.gpsSource ?? 2);
  view.setUint8(23, overrides.satellites ?? 8);
  view.setUint8(24, overrides.peerCount ?? 0);
  view.setFloat32(28, overrides.lat ?? 4.6, true);
  view.setFloat32(32, overrides.lon ?? -74.1, true);
  view.setFloat32(36, overrides.accuracy ?? 10, true);
  view.setInt32(40, overrides.altitudeM ?? 2600, true);
  view.setUint16(44, overrides.fixAgeMs ?? 1000, true);
  view.setUint16(46, overrides.bootId ?? 25701, true);
  view.setUint32(48, overrides.uptimeS ?? 60, true);
  view.setUint32(52, overrides.seq ?? 7, true);
  return bytes;
}

function peerBytes() {
  const bytes = new Uint8Array(LM_PEER_SNAPSHOT_HEADER_BYTES + 56);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, LM_RADIO_MAGIC, true);
  view.setUint8(2, LM_RADIO_VERSION);
  view.setUint8(3, LM_RADIO_TYPE_PEER_SNAPSHOT);
  view.setUint8(4, 1);
  view.setUint32(8, 300, true);
  const offset = LM_PEER_SNAPSHOT_HEADER_BYTES;
  writeFixed(view, offset, 17, 'A608');
  view.setUint8(offset + 17, 1);
  view.setUint8(offset + 18, 6);
  view.setUint8(offset + 19, 1);
  view.setFloat32(offset + 24, 4.61, true);
  view.setFloat32(offset + 28, -74.11, true);
  view.setFloat32(offset + 32, 12, true);
  view.setInt32(offset + 36, 2550, true);
  view.setUint32(offset + 40, 1200, true);
  view.setUint32(offset + 44, 9, true);
  view.setUint16(offset + 48, 25701, true);
  view.setUint16(offset + 50, 2000, true);
  view.setUint16(offset + 52, 12, true);
  view.setInt8(offset + 54, -67);
  return bytes;
}

function ackBytes(msgId = 123) {
  const bytes = new Uint8Array(48);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, LM_BLE_MAGIC, true);
  view.setUint8(2, LM_BLE_VERSION);
  view.setUint8(3, LM_BLE_TYPE_TEXT_ACK);
  view.setUint32(4, msgId, true);
  writeFixed(view, 8, 17, '5494');
  writeFixed(view, 25, 17, 'A608');
  view.setUint16(42, 25701, true);
  view.setUint8(44, 0);
  return bytes;
}

class FakeCharacteristic extends EventTarget {
  constructor(properties = { write: true, writeWithoutResponse: true }) {
    super();
    this.properties = properties;
    this.value = null;
    this.writes = [];
    this.notifying = false;
  }

  async startNotifications() {
    this.notifying = true;
    return this;
  }

  async readValue() {
    return this.value;
  }

  async writeValueWithoutResponse(bytes) {
    this.writes.push({ mode: 'without', bytes: new Uint8Array(bytes) });
  }

  async writeValueWithResponse(bytes) {
    this.writes.push({ mode: 'with', bytes: new Uint8Array(bytes) });
  }

  notify(bytes) {
    this.value = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.dispatchEvent(new Event('characteristicvaluechanged'));
  }
}

function makeDevice() {
  const chars = {
    [LM_BLE_UUIDS.gpsRx]: new FakeCharacteristic(),
    [LM_BLE_UUIDS.peerTx]: new FakeCharacteristic(),
    [LM_BLE_UUIDS.status]: new FakeCharacteristic(),
    [LM_BLE_UUIDS.textRx]: new FakeCharacteristic(),
    [LM_BLE_UUIDS.textTx]: new FakeCharacteristic(),
  };
  chars[LM_BLE_UUIDS.status].value = new DataView(statusBytes().buffer);
  const service = {
    async getCharacteristic(uuid) {
      if (!chars[uuid]) {
        throw new Error(`missing characteristic ${uuid}`);
      }
      return chars[uuid];
    },
  };
  const device = new EventTarget();
  device.name = 'LM-5494';
  device.id = 'fake-device';
  device.gatt = {
    connected: false,
    async connect() {
      this.connected = true;
      return {
        async getPrimaryService() {
          return service;
        },
      };
    },
    disconnect() {
      this.connected = false;
      device.dispatchEvent(new Event('gattserverdisconnected'));
    },
  };
  return { device, chars };
}

test('BLE service connects, parses notifications and writes packets', async () => {
  const ble = new LmBle();
  const { device, chars } = makeDevice();
  const texts = [];
  const acks = [];
  ble.addEventListener('text', (event) => texts.push(event.detail));
  ble.addEventListener('ack', (event) => acks.push(event.detail));

  await ble.connectDevice(device);
  assert.equal(ble.connected, true);
  assert.equal(ble.status.nodeId, '5494');
  assert.equal(ble.status.bootId, 25701);
  assert.equal(chars[LM_BLE_UUIDS.status].notifying, true);
  assert.equal(chars[LM_BLE_UUIDS.peerTx].notifying, true);
  assert.equal(chars[LM_BLE_UUIDS.textTx].notifying, true);

  chars[LM_BLE_UUIDS.status].notify(statusBytes({ nodeId: 'A608', hasFix: 0, seq: 8 }));
  assert.equal(ble.status.nodeId, 'A608');
  assert.equal(ble.status.hasFix, false);
  assert.equal(ble.status.seq, 8);

  chars[LM_BLE_UUIDS.peerTx].notify(peerBytes());
  assert.equal(ble.peers.length, 1);
  assert.equal(ble.peers[0].id, 'A608');
  assert.equal(ble.hubUptimeS, 300);

  const textPacket = {
    msgId: 55,
    sentAt: 1700000000,
    from: '5494',
    to: '*',
    fromBootId: 25701,
    ttl: 2,
    flags: 1,
    text: 'hola',
  };
  chars[LM_BLE_UUIDS.textTx].notify(encodeTextPacket(textPacket));
  assert.equal(texts.length, 1);
  assert.equal(texts[0].msgId, 55);
  assert.equal(texts[0].text, 'hola');

  chars[LM_BLE_UUIDS.textTx].notify(ackBytes(55));
  assert.equal(acks.length, 1);
  assert.equal(acks[0].msgId, 55);
  assert.equal(acks[0].isError, false);

  const gps = encodeGpsPacket({
    seq: 12,
    lat: 4.6,
    lon: -74.1,
    accuracy: 9,
    altitudeM: 2500,
    fixAgeMs: 500,
    satellites: 0,
    valid: true,
  });
  assert.equal(await ble.writeGps(gps), true);
  assert.equal(chars[LM_BLE_UUIDS.gpsRx].writes.length, 1);
  assert.equal(chars[LM_BLE_UUIDS.gpsRx].writes[0].mode, 'without');
  assert.equal(decodeGpsPacket(chars[LM_BLE_UUIDS.gpsRx].writes[0].bytes).seq, 12);

  const outgoing = encodeTextPacket({ ...textPacket, msgId: 56, text: 'adios' });
  assert.equal(await ble.sendText(outgoing), true);
  assert.equal(chars[LM_BLE_UUIDS.textRx].writes.length, 1);
  assert.equal(chars[LM_BLE_UUIDS.textRx].writes[0].mode, 'with');
  assert.equal(decodeText(chars[LM_BLE_UUIDS.textRx].writes[0].bytes).text, 'adios');

  await ble.disconnect();
  assert.equal(ble.connected, false);
  assert.equal(ble.status, null);
  assert.equal(ble.peers.length, 0);
});

test('text write falls back to without response', async () => {
  const ble = new LmBle();
  const { device, chars } = makeDevice();
  await ble.connectDevice(device);
  const characteristic = chars[LM_BLE_UUIDS.textRx];
  characteristic.writeValueWithResponse = async () => {
    throw new Error('long write failed');
  };
  const ok = await ble.sendText(
    encodeTextPacket({
      msgId: 77,
      sentAt: 1,
      from: '5494',
      to: '*',
      fromBootId: 25701,
      ttl: 0,
      flags: 1,
      text: 'fallback',
    }),
  );
  assert.equal(ok, true);
  assert.equal(characteristic.writes.length, 1);
  assert.equal(characteristic.writes[0].mode, 'without');
  await ble.disconnect();
});
