import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../ble/lm_packets.dart';

enum LmChatStatus { sent, delivered, failed }

class LmChatMessage {
  const LmChatMessage({
    required this.msgId,
    required this.from,
    required this.to,
    required this.fromBootId,
    required this.sentAt,
    required this.text,
    required this.broadcast,
    required this.outgoing,
    required this.status,
  });

  final int msgId;
  final String from;
  final String to;
  final int fromBootId;
  final DateTime sentAt;
  final String text;
  final bool broadcast;
  final bool outgoing;
  final LmChatStatus status;

  LmChatMessage copyWith({LmChatStatus? status}) {
    return LmChatMessage(
      msgId: msgId,
      from: from,
      to: to,
      fromBootId: fromBootId,
      sentAt: sentAt,
      text: text,
      broadcast: broadcast,
      outgoing: outgoing,
      status: status ?? this.status,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'msgId': msgId,
      'from': from,
      'to': to,
      'fromBootId': fromBootId,
      'sentAt': sentAt.toIso8601String(),
      'text': text,
      'broadcast': broadcast,
      'outgoing': outgoing,
      'status': status.name,
    };
  }

  static LmChatMessage? fromJson(Object? value) {
    if (value is! Map) {
      return null;
    }
    final map = value.cast<String, dynamic>();
    final msgId = map['msgId'];
    final text = map['text'];
    final sentAt = DateTime.tryParse('${map['sentAt'] ?? ''}');
    if (msgId is! num || text is! String || sentAt == null) {
      return null;
    }
    final statusName = '${map['status'] ?? ''}';
    final status = LmChatStatus.values.firstWhere(
      (item) => item.name == statusName,
      orElse: () => LmChatStatus.sent,
    );
    return LmChatMessage(
      msgId: msgId.toInt(),
      from: '${map['from'] ?? ''}',
      to: '${map['to'] ?? ''}',
      fromBootId: (map['fromBootId'] is num)
          ? (map['fromBootId'] as num).toInt()
          : 0,
      sentAt: sentAt,
      text: text,
      broadcast: map['broadcast'] == true,
      outgoing: map['outgoing'] == true,
      status: status,
    );
  }
}

class LmChatStore extends ChangeNotifier {
  static const _storageKey = 'lm_chat_v1';
  static const maxMessages = 200;

  final List<LmChatMessage> _messages = [];
  SharedPreferences? _prefs;
  bool _disposed = false;

  List<LmChatMessage> get messages => List.unmodifiable(_messages);

  Future<void> load() async {
    _prefs = await SharedPreferences.getInstance();
    final raw = _prefs!.getString(_storageKey);
    if (raw == null || raw.isEmpty) {
      return;
    }
    try {
      final decoded = jsonDecode(raw);
      if (decoded is! List) {
        return;
      }
      _messages
        ..clear()
        ..addAll(
          decoded.map(LmChatMessage.fromJson).whereType<LmChatMessage>(),
        );
      _trim();
      notifyListeners();
    } catch (_) {
      _messages.clear();
    }
  }

  Future<void> addOutgoing(LmTextMessage packet) async {
    final message = LmChatMessage(
      msgId: packet.msgId,
      from: packet.from,
      to: packet.to,
      fromBootId: packet.fromBootId,
      sentAt: _sentAt(packet),
      text: packet.text,
      broadcast: packet.broadcast,
      outgoing: true,
      status: LmChatStatus.sent,
    );
    _messages.add(message);
    _trim();
    notifyListeners();
    await _persist();
  }

  Future<void> addIncoming(LmTextMessage packet) async {
    final duplicate = _messages.any(
      (message) =>
          !message.outgoing &&
          message.msgId == packet.msgId &&
          message.from == packet.from &&
          message.fromBootId == packet.fromBootId,
    );
    if (duplicate) {
      return;
    }
    _messages.add(
      LmChatMessage(
        msgId: packet.msgId,
        from: packet.from,
        to: packet.to,
        fromBootId: packet.fromBootId,
        sentAt: _sentAt(packet),
        text: packet.text,
        broadcast: packet.broadcast,
        outgoing: false,
        status: LmChatStatus.delivered,
      ),
    );
    _trim();
    notifyListeners();
    await _persist();
  }

  Future<void> applyAck(LmTextAck ack) async {
    final index = _messages.indexWhere(
      (message) => message.outgoing && message.msgId == ack.msgId,
    );
    if (index < 0) {
      return;
    }
    final status = ack.isError ? LmChatStatus.failed : LmChatStatus.delivered;
    if (_messages[index].status == status) {
      return;
    }
    _messages[index] = _messages[index].copyWith(status: status);
    notifyListeners();
    await _persist();
  }

  Future<void> clear() async {
    _messages.clear();
    notifyListeners();
    await _persist();
  }

  DateTime _sentAt(LmTextMessage packet) {
    if (packet.sentAt == 0) {
      return DateTime.now();
    }
    return DateTime.fromMillisecondsSinceEpoch(
      packet.sentAt * 1000,
      isUtc: true,
    ).toLocal();
  }

  void _trim() {
    final excess = _messages.length - maxMessages;
    if (excess > 0) {
      _messages.removeRange(0, excess);
    }
  }

  Future<void> _persist() async {
    final prefs = _prefs;
    if (prefs == null) {
      return;
    }
    await prefs.setString(
      _storageKey,
      jsonEncode(_messages.map((message) => message.toJson()).toList()),
    );
  }

  @override
  void notifyListeners() {
    if (!_disposed) {
      super.notifyListeners();
    }
  }

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }
}
