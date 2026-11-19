import 'dart:convert';
import 'dart:typed_data';

const int lmBleMagic = 0x4C42;
const int lmBleVersion = 1;
const int lmBleTypeGps = 1;
const int lmBleTypeStatus = 2;
const int lmBleTypeText = 3;
const int lmBleTypeTextAck = 4;
const int lmGpsFlagValid = 0x01;
const int lmTextFlagBroadcast = 0x01;
const int lmTextAckReceived = 0;
const int lmTextAckError = 1;
const int lmTextMaxBytes = 180;
const int lmTextPacketBytes = 232;
const int lmTextAckBytes = 48;

const int lmRadioMagic = 0x4C4D;
const int lmRadioVersion = 2;
const int lmRadioTypePeerSnapshot = 2;
const int lmNodeMax = 4;

String lmSourceName(int source) {
  switch (source) {
    case 1:
      return 'serial';
    case 2:
      return 'phone';
    default:
      return 'unknown';
  }
}

String _readString(ByteData data, int offset, int length) {
  final bytes = data.buffer.asUint8List(data.offsetInBytes + offset, length);
  final end = bytes.indexOf(0);
  final slice = end >= 0 ? bytes.sublist(0, end) : bytes;
  return utf8.decode(slice, allowMalformed: true);
}

void _writeString(ByteData data, int offset, int length, String value) {
  final target = data.buffer.asUint8List(data.offsetInBytes + offset, length);
  target.fillRange(0, length, 0);
  final bytes = utf8.encode(value);
  final count = bytes.length > length ? length : bytes.length;
  target.setRange(0, count, bytes);
}

class LmGpsPacket {
  const LmGpsPacket({
    required this.seq,
    required this.lat,
    required this.lon,
    required this.accuracy,
    required this.altitudeM,
    required this.fixAgeMs,
    required this.satellites,
    required this.valid,
  });

  final int seq;
  final double lat;
  final double lon;
  final double accuracy;
  final int altitudeM;
  final int fixAgeMs;
  final int satellites;
  final bool valid;

  Uint8List toBytes() {
    final bytes = Uint8List(28);
    final data = ByteData.sublistView(bytes);
    data.setUint16(0, lmBleMagic, Endian.little);
    data.setUint8(2, lmBleVersion);
    data.setUint8(3, lmBleTypeGps);
    data.setUint32(4, seq & 0xFFFFFFFF, Endian.little);
    data.setFloat32(8, lat, Endian.little);
    data.setFloat32(12, lon, Endian.little);
    data.setFloat32(16, accuracy, Endian.little);
    data.setInt32(20, altitudeM, Endian.little);
    data.setUint16(24, fixAgeMs.clamp(0, 65535), Endian.little);
    data.setUint8(26, satellites.clamp(0, 255));
    data.setUint8(27, valid ? lmGpsFlagValid : 0);
    return bytes;
  }
}

class LmStatus {
  const LmStatus({
    required this.nodeId,
    required this.hasFix,
    required this.gpsSource,
    required this.satellites,
    required this.peerCount,
    required this.lat,
    required this.lon,
    required this.accuracy,
    required this.altitudeM,
    required this.fixAgeMs,
    required this.bootId,
    required this.uptimeS,
    required this.seq,
  });

  final String nodeId;
  final bool hasFix;
  final int gpsSource;
  final int satellites;
  final int peerCount;
  final double lat;
  final double lon;
  final double accuracy;
  final int altitudeM;
  final int fixAgeMs;
  final int bootId;
  final int uptimeS;
  final int seq;

  static LmStatus? tryParse(List<int> value) {
    if (value.length < 56) {
      return null;
    }
    final data = ByteData.sublistView(Uint8List.fromList(value));
    if (data.getUint16(0, Endian.little) != lmBleMagic ||
        data.getUint8(2) != lmBleVersion ||
        data.getUint8(3) != lmBleTypeStatus) {
      return null;
    }
    return LmStatus(
      nodeId: _readString(data, 4, 17),
      hasFix: data.getUint8(21) != 0,
      gpsSource: data.getUint8(22),
      satellites: data.getUint8(23),
      peerCount: data.getUint8(24),
      lat: data.getFloat32(28, Endian.little),
      lon: data.getFloat32(32, Endian.little),
      accuracy: data.getFloat32(36, Endian.little),
      altitudeM: data.getInt32(40, Endian.little),
      fixAgeMs: data.getUint16(44, Endian.little),
      bootId: data.getUint16(46, Endian.little),
      uptimeS: data.getUint32(48, Endian.little),
      seq: data.getUint32(52, Endian.little),
    );
  }
}

class LmTextMessage {
  const LmTextMessage({
    required this.msgId,
    required this.sentAt,
    required this.from,
    required this.to,
    required this.fromBootId,
    required this.flags,
    required this.text,
    this.ttl = 0,
  });

  final int msgId;
  final int sentAt;
  final String from;
  final String to;
  final int fromBootId;
  final int flags;
  final String text;
  final int ttl;

  bool get broadcast => (flags & lmTextFlagBroadcast) != 0 || to == '*';

  Uint8List toBytes() {
    final bytes = Uint8List(lmTextPacketBytes);
    final data = ByteData.sublistView(bytes);
    final encoded = utf8.encode(text);
    final textLen = encoded.length > lmTextMaxBytes
        ? lmTextMaxBytes
        : encoded.length;
    data.setUint16(0, lmBleMagic, Endian.little);
    data.setUint8(2, lmBleVersion);
    data.setUint8(3, lmBleTypeText);
    data.setUint32(4, msgId & 0xFFFFFFFF, Endian.little);
    data.setUint32(8, sentAt & 0xFFFFFFFF, Endian.little);
    _writeString(data, 12, 17, from);
    _writeString(data, 29, 17, to);
    data.setUint16(46, fromBootId & 0xFFFF, Endian.little);
    data.setUint8(48, ttl & 0xFF);
    data.setUint8(49, flags & 0xFF);
    data.setUint8(50, textLen);
    data.setUint8(51, 0);
    bytes.setRange(52, 52 + textLen, encoded);
    return bytes;
  }

  static LmTextMessage? tryParse(List<int> value) {
    if (value.length < 52) {
      return null;
    }
    final data = ByteData.sublistView(Uint8List.fromList(value));
    if (data.getUint16(0, Endian.little) != lmBleMagic ||
        data.getUint8(2) != lmBleVersion ||
        data.getUint8(3) != lmBleTypeText) {
      return null;
    }
    final textLen = data.getUint8(50);
    if (textLen == 0 ||
        textLen > lmTextMaxBytes ||
        value.length < 52 + textLen) {
      return null;
    }
    final textBytes = value.sublist(52, 52 + textLen);
    return LmTextMessage(
      msgId: data.getUint32(4, Endian.little),
      sentAt: data.getUint32(8, Endian.little),
      from: _readString(data, 12, 17),
      to: _readString(data, 29, 17),
      fromBootId: data.getUint16(46, Endian.little),
      ttl: data.getUint8(48),
      flags: data.getUint8(49),
      text: utf8.decode(textBytes, allowMalformed: true),
    );
  }
}

class LmTextAck {
  const LmTextAck({
    required this.msgId,
    required this.from,
    required this.to,
    required this.fromBootId,
    required this.status,
  });

  final int msgId;
  final String from;
  final String to;
  final int fromBootId;
  final int status;

  bool get isError => status == lmTextAckError;

  static LmTextAck? tryParse(List<int> value) {
    if (value.length < lmTextAckBytes) {
      return null;
    }
    final data = ByteData.sublistView(Uint8List.fromList(value));
    if (data.getUint16(0, Endian.little) != lmBleMagic ||
        data.getUint8(2) != lmBleVersion ||
        data.getUint8(3) != lmBleTypeTextAck) {
      return null;
    }
    return LmTextAck(
      msgId: data.getUint32(4, Endian.little),
      from: _readString(data, 8, 17),
      to: _readString(data, 25, 17),
      fromBootId: data.getUint16(42, Endian.little),
      status: data.getUint8(44),
    );
  }
}

class LmPeer {
  const LmPeer({
    required this.id,
    required this.hasFix,
    required this.satellites,
    required this.gpsSource,
    required this.lat,
    required this.lon,
    required this.accuracy,
    required this.altitudeM,
    required this.uptimeS,
    required this.seq,
    required this.bootId,
    required this.fixAgeMs,
    required this.ageS,
    required this.rssi,
  });

  final String id;
  final bool hasFix;
  final int satellites;
  final int gpsSource;
  final double lat;
  final double lon;
  final double accuracy;
  final int altitudeM;
  final int uptimeS;
  final int seq;
  final int bootId;
  final int fixAgeMs;
  final int ageS;
  final int rssi;

  static LmPeer _parse(ByteData data, int offset) {
    return LmPeer(
      id: _readString(data, offset, 17),
      hasFix: data.getUint8(offset + 17) != 0,
      satellites: data.getUint8(offset + 18),
      gpsSource: data.getUint8(offset + 19),
      lat: data.getFloat32(offset + 24, Endian.little),
      lon: data.getFloat32(offset + 28, Endian.little),
      accuracy: data.getFloat32(offset + 32, Endian.little),
      altitudeM: data.getInt32(offset + 36, Endian.little),
      uptimeS: data.getUint32(offset + 40, Endian.little),
      seq: data.getUint32(offset + 44, Endian.little),
      bootId: data.getUint16(offset + 48, Endian.little),
      fixAgeMs: data.getUint16(offset + 50, Endian.little),
      ageS: data.getUint16(offset + 52, Endian.little),
      rssi: data.getInt8(offset + 54),
    );
  }
}

class LmPeerSnapshot {
  const LmPeerSnapshot({required this.hubUptimeS, required this.peers});

  final int hubUptimeS;
  final List<LmPeer> peers;

  static LmPeerSnapshot? tryParse(List<int> value) {
    if (value.length < 12) {
      return null;
    }
    final data = ByteData.sublistView(Uint8List.fromList(value));
    if (data.getUint16(0, Endian.little) != lmRadioMagic ||
        data.getUint8(2) != lmRadioVersion ||
        data.getUint8(3) != lmRadioTypePeerSnapshot) {
      return null;
    }
    final count = data.getUint8(4).clamp(0, lmNodeMax);
    if (value.length < 12 + count * 56) {
      return null;
    }
    final peers = <LmPeer>[];
    for (var i = 0; i < count; i++) {
      peers.add(LmPeer._parse(data, 12 + i * 56));
    }
    return LmPeerSnapshot(
      hubUptimeS: data.getUint32(8, Endian.little),
      peers: peers,
    );
  }
}
