import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:lora_messenger/ble/lm_packets.dart';
import 'package:lora_messenger/chat/lm_chat_store.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('GPS packet has the firmware layout', () {
    final bytes = const LmGpsPacket(
      seq: 7,
      lat: 19.4326,
      lon: -99.1332,
      accuracy: 8.5,
      altitudeM: 2240,
      fixAgeMs: 1200,
      satellites: 9,
      valid: true,
    ).toBytes();
    final data = ByteData.sublistView(bytes);

    expect(bytes.length, 28);
    expect(data.getUint16(0, Endian.little), lmBleMagic);
    expect(data.getUint8(2), lmBleVersion);
    expect(data.getUint8(3), lmBleTypeGps);
    expect(data.getUint32(4, Endian.little), 7);
    expect(data.getFloat32(8, Endian.little), closeTo(19.4326, 0.0001));
    expect(data.getFloat32(12, Endian.little), closeTo(-99.1332, 0.0001));
    expect(data.getUint16(24, Endian.little), 1200);
    expect(data.getUint8(26), 9);
    expect(data.getUint8(27), lmGpsFlagValid);
  });

  test('status packet parses node state', () {
    final bytes = Uint8List(56);
    final data = ByteData.sublistView(bytes);
    data.setUint16(0, lmBleMagic, Endian.little);
    data.setUint8(2, lmBleVersion);
    data.setUint8(3, lmBleTypeStatus);
    bytes.setRange(4, 4 + 'LM-5494'.length, 'LM-5494'.codeUnits);
    data.setUint8(21, 1);
    data.setUint8(22, 2);
    data.setUint8(23, 9);
    data.setUint8(24, 3);
    data.setFloat32(28, 19.4326, Endian.little);
    data.setFloat32(32, -99.1332, Endian.little);
    data.setFloat32(36, 8.5, Endian.little);
    data.setInt32(40, 2240, Endian.little);
    data.setUint16(44, 1500, Endian.little);
    data.setUint16(46, 42, Endian.little);
    data.setUint32(48, 3600, Endian.little);
    data.setUint32(52, 99, Endian.little);

    final status = LmStatus.tryParse(bytes);

    expect(status, isNotNull);
    expect(status!.nodeId, 'LM-5494');
    expect(status.hasFix, isTrue);
    expect(status.gpsSource, 2);
    expect(status.satellites, 9);
    expect(status.peerCount, 3);
    expect(status.lat, closeTo(19.4326, 0.0001));
    expect(status.lon, closeTo(-99.1332, 0.0001));
    expect(status.accuracy, closeTo(8.5, 0.0001));
    expect(status.altitudeM, 2240);
    expect(status.fixAgeMs, 1500);
    expect(status.bootId, 42);
    expect(status.uptimeS, 3600);
    expect(status.seq, 99);
  });

  test('peer snapshot parses hub state', () {
    final bytes = Uint8List(12 + 56);
    final data = ByteData.sublistView(bytes);
    data.setUint16(0, lmRadioMagic, Endian.little);
    data.setUint8(2, lmRadioVersion);
    data.setUint8(3, lmRadioTypePeerSnapshot);
    data.setUint8(4, 1);
    data.setUint32(8, 1234, Endian.little);
    bytes.setRange(12, 12 + 'LM-1234'.length, 'LM-1234'.codeUnits);
    data.setUint8(12 + 17, 1);
    data.setUint8(12 + 18, 7);
    data.setUint8(12 + 19, 1);
    data.setFloat32(12 + 24, 10.5, Endian.little);
    data.setFloat32(12 + 28, -20.25, Endian.little);
    data.setFloat32(12 + 32, 12.0, Endian.little);
    data.setInt32(12 + 36, 500, Endian.little);
    data.setUint32(12 + 40, 600, Endian.little);
    data.setUint32(12 + 44, 77, Endian.little);
    data.setUint16(12 + 48, 5, Endian.little);
    data.setUint16(12 + 50, 800, Endian.little);
    data.setUint16(12 + 52, 3, Endian.little);
    data.setInt8(12 + 54, -55);

    final snapshot = LmPeerSnapshot.tryParse(bytes);

    expect(snapshot, isNotNull);
    expect(snapshot!.hubUptimeS, 1234);
    expect(snapshot.peers, hasLength(1));
    expect(snapshot.peers.first.id, 'LM-1234');
    expect(snapshot.peers.first.hasFix, isTrue);
    expect(snapshot.peers.first.satellites, 7);
    expect(snapshot.peers.first.gpsSource, 1);
    expect(snapshot.peers.first.lat, closeTo(10.5, 0.0001));
    expect(snapshot.peers.first.lon, closeTo(-20.25, 0.0001));
    expect(snapshot.peers.first.accuracy, closeTo(12.0, 0.0001));
    expect(snapshot.peers.first.altitudeM, 500);
    expect(snapshot.peers.first.uptimeS, 600);
    expect(snapshot.peers.first.seq, 77);
    expect(snapshot.peers.first.bootId, 5);
    expect(snapshot.peers.first.fixAgeMs, 800);
    expect(snapshot.peers.first.ageS, 3);
    expect(snapshot.peers.first.rssi, -55);
  });

  test('text packet round-trips with the firmware layout', () {
    const message = LmTextMessage(
      msgId: 0x12345678,
      sentAt: 1700000000,
      from: 'LM-5494',
      to: '*',
      fromBootId: 42,
      ttl: 2,
      flags: lmTextFlagBroadcast,
      text: 'Hola ñandú',
    );
    final bytes = message.toBytes();
    final data = ByteData.sublistView(bytes);

    expect(bytes.length, lmTextPacketBytes);
    expect(data.getUint16(0, Endian.little), lmBleMagic);
    expect(data.getUint8(2), lmBleVersion);
    expect(data.getUint8(3), lmBleTypeText);
    expect(data.getUint32(4, Endian.little), 0x12345678);
    expect(data.getUint32(8, Endian.little), 1700000000);
    expect(data.getUint16(46, Endian.little), 42);
    expect(data.getUint8(48), 2);
    expect(data.getUint8(49), lmTextFlagBroadcast);

    final parsed = LmTextMessage.tryParse(bytes);
    expect(parsed, isNotNull);
    expect(parsed!.msgId, 0x12345678);
    expect(parsed.from, 'LM-5494');
    expect(parsed.to, '*');
    expect(parsed.broadcast, isTrue);
    expect(parsed.text, 'Hola ñandú');
  });

  test('text ack parses delivery state', () {
    final bytes = Uint8List(lmTextAckBytes);
    final data = ByteData.sublistView(bytes);
    data.setUint16(0, lmBleMagic, Endian.little);
    data.setUint8(2, lmBleVersion);
    data.setUint8(3, lmBleTypeTextAck);
    data.setUint32(4, 0x12345678, Endian.little);
    bytes.setRange(8, 8 + 'LM-5494'.length, 'LM-5494'.codeUnits);
    bytes.setRange(25, 25 + 'LM-A608'.length, 'LM-A608'.codeUnits);
    data.setUint16(42, 42, Endian.little);
    data.setUint8(44, lmTextAckReceived);

    final ack = LmTextAck.tryParse(bytes);
    expect(ack, isNotNull);
    expect(ack!.msgId, 0x12345678);
    expect(ack.from, 'LM-5494');
    expect(ack.to, 'LM-A608');
    expect(ack.fromBootId, 42);
    expect(ack.isError, isFalse);
  });

  test('chat store persists outgoing status updates', () async {
    SharedPreferences.setMockInitialValues({});
    final store = LmChatStore();
    await store.load();
    const packet = LmTextMessage(
      msgId: 77,
      sentAt: 1700000000,
      from: 'LM-5494',
      to: 'LM-A608',
      fromBootId: 5,
      flags: 0,
      text: 'Prueba',
    );
    await store.addOutgoing(packet);
    await store.applyAck(
      const LmTextAck(
        msgId: 77,
        from: 'LM-5494',
        to: 'LM-A608',
        fromBootId: 5,
        status: lmTextAckReceived,
      ),
    );

    expect(store.messages, hasLength(1));
    expect(store.messages.first.status, LmChatStatus.delivered);

    final restored = LmChatStore();
    await restored.load();
    expect(restored.messages, hasLength(1));
    expect(restored.messages.first.text, 'Prueba');
    expect(restored.messages.first.status, LmChatStatus.delivered);
  });
}
