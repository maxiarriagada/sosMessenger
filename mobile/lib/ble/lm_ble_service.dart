import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:flutter_blue_plus/flutter_blue_plus.dart';

import 'lm_ids.dart';
import 'lm_packets.dart';

class LmBleService extends ChangeNotifier {
  BluetoothAdapterState _adapterState = BluetoothAdapterState.unknown;
  bool _isScanning = false;
  bool _connecting = false;
  bool _connected = false;
  bool _intentionalDisconnect = false;
  bool _shouldReconnect = false;
  bool _writeInFlight = false;
  bool _textWriteInFlight = false;
  int _reconnectAttempt = 0;
  Timer? _reconnectTimer;
  String? _error;
  String? _lastEvent;
  int _mtu = 23;
  BluetoothDevice? _device;
  BluetoothCharacteristic? _gpsRx;
  BluetoothCharacteristic? _peerTx;
  BluetoothCharacteristic? _statusChar;
  BluetoothCharacteristic? _textRx;
  BluetoothCharacteristic? _textTx;
  LmStatus? _status;
  DateTime? _lastStatusAt;
  List<LmPeer> _peers = const [];
  List<ScanResult> _scanResults = const [];

  StreamSubscription<BluetoothAdapterState>? _adapterSub;
  StreamSubscription<List<ScanResult>>? _scanSub;
  StreamSubscription<bool>? _scanStateSub;
  StreamSubscription<BluetoothConnectionState>? _connSub;
  StreamSubscription<List<int>>? _statusSub;
  StreamSubscription<List<int>>? _peerSub;
  StreamSubscription<List<int>>? _textSub;
  final _textController = StreamController<LmTextMessage>.broadcast();
  final _textAckController = StreamController<LmTextAck>.broadcast();
  final _random = Random.secure();
  bool _disposed = false;

  BluetoothAdapterState get adapterState => _adapterState;
  bool get isScanning => _isScanning;
  bool get connecting => _connecting;
  bool get connected => _connected;
  bool get reconnecting => _shouldReconnect && !_connected && !_connecting;
  bool get adapterOn => _adapterState == BluetoothAdapterState.on;
  int get mtu => _mtu;
  BluetoothDevice? get device => _device;
  LmStatus? get status => _status;
  DateTime? get lastStatusAt => _lastStatusAt;
  List<LmPeer> get peers => _peers;
  List<ScanResult> get scanResults => _scanResults;
  String? get error => _error;
  String? get lastEvent => _lastEvent;
  bool get textReady => _textRx != null && _textTx != null;
  Stream<LmTextMessage> get textMessages => _textController.stream;
  Stream<LmTextAck> get textAcks => _textAckController.stream;

  String get deviceName {
    final d = _device;
    if (d == null) {
      return '';
    }
    return _nameOfResult(d);
  }

  void init() {
    FlutterBluePlus.setLogLevel(LogLevel.info, color: false);
    _adapterSub ??= FlutterBluePlus.adapterState.listen((state) {
      _adapterState = state;
      notifyListeners();
    });
    _scanStateSub ??= FlutterBluePlus.isScanning.listen((value) {
      _isScanning = value;
      notifyListeners();
    });
    _scanSub ??= FlutterBluePlus.onScanResults.listen(
      (results) {
        _scanResults =
            results.where((r) => _nameOf(r).startsWith('LM-')).toList()
              ..sort((a, b) => b.rssi.compareTo(a.rssi));
        notifyListeners();
      },
      onError: (Object e) {
        _error = 'Escaneo: $e';
        notifyListeners();
      },
    );
  }

  String nameOf(ScanResult result) => _nameOf(result);

  String _nameOf(ScanResult result) {
    final adv = result.advertisementData.advName;
    return adv.isNotEmpty ? adv : result.device.platformName;
  }

  Future<void> startScan() async {
    _shouldReconnect = false;
    _reconnectAttempt = 0;
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
    _error = null;
    _lastEvent = null;
    notifyListeners();
    if (!adapterOn) {
      _error = 'Bluetooth está apagado';
      notifyListeners();
      return;
    }
    try {
      await FlutterBluePlus.startScan(
        withServices: [LmIds.service],
        timeout: const Duration(seconds: 15),
        androidScanMode: AndroidScanMode.lowLatency,
      );
    } catch (e) {
      _error = 'No se pudo escanear: $e';
      notifyListeners();
    }
  }

  Future<void> stopScan() async {
    try {
      await FlutterBluePlus.stopScan();
    } catch (_) {}
  }

  Future<void> connect(BluetoothDevice target) async {
    _shouldReconnect = true;
    _reconnectAttempt = 0;
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
    await _connectTo(target);
  }

  Future<void> _connectTo(
    BluetoothDevice target, {
    bool isReconnect = false,
  }) async {
    if (_connecting) {
      return;
    }
    _connecting = true;
    _error = null;
    _lastEvent = isReconnect
        ? 'Reconectando con ${target.platformName}...'
        : 'Conectando a ${target.platformName}...';
    notifyListeners();

    try {
      _reconnectTimer?.cancel();
      _reconnectTimer = null;
      await stopScan();
      if (_device != null && _device!.remoteId != target.remoteId) {
        final keepReconnect = _shouldReconnect;
        await disconnect();
        _shouldReconnect = keepReconnect;
      }

      _device = target;
      _status = null;
      _peers = const [];
      _connSub?.cancel();
      _connSub = target.connectionState.listen(_onConnectionState);

      await target.connect(
        license: License.nonprofit,
        mtu: 247,
        timeout: Duration(seconds: isReconnect ? 10 : 20),
      );

      _connected = true;
      _mtu = target.mtuNow;
      _lastEvent = 'Descubriendo servicios...';
      notifyListeners();

      final services = await target.discoverServices();
      BluetoothService? lmService;
      for (final service in services) {
        if (service.serviceUuid == LmIds.service) {
          lmService = service;
          break;
        }
      }
      if (lmService == null) {
        throw StateError('El nodo no expone el servicio LM');
      }

      for (final characteristic in lmService.characteristics) {
        if (characteristic.characteristicUuid == LmIds.gpsRx) {
          _gpsRx = characteristic;
        } else if (characteristic.characteristicUuid == LmIds.peerTx) {
          _peerTx = characteristic;
        } else if (characteristic.characteristicUuid == LmIds.status) {
          _statusChar = characteristic;
        } else if (characteristic.characteristicUuid == LmIds.textRx) {
          _textRx = characteristic;
        } else if (characteristic.characteristicUuid == LmIds.textTx) {
          _textTx = characteristic;
        }
      }
      if (_gpsRx == null || _peerTx == null || _statusChar == null) {
        throw StateError('Faltan características del protocolo LM');
      }
      if (_textRx == null || _textTx == null) {
        throw StateError('Faltan características de mensajería LM');
      }

      await _statusSub?.cancel();
      await _peerSub?.cancel();
      await _textSub?.cancel();
      _statusSub = _statusChar!.onValueReceived.listen(_onStatus);
      _peerSub = _peerTx!.onValueReceived.listen(_onPeers);
      _textSub = _textTx!.onValueReceived.listen(_onTextValue);

      final initial = await _statusChar!.read();
      _onStatus(initial);
      await _statusChar!.setNotifyValue(true);
      await _peerTx!.setNotifyValue(true);
      await _textTx!.setNotifyValue(true);

      _reconnectAttempt = 0;
      _lastEvent = 'Conectado a ${_nameOfResult(target)}';
    } catch (e) {
      _error = 'Conexión: $e';
      _lastEvent = null;
      await _cleanupConnection();
      if (_shouldReconnect && !_disposed) {
        _scheduleReconnect();
      }
    } finally {
      _connecting = false;
      notifyListeners();
    }
  }

  String _nameOfResult(BluetoothDevice device) {
    for (final result in _scanResults) {
      if (result.device.remoteId == device.remoteId) {
        final name = _nameOf(result);
        if (name.isNotEmpty) {
          return name;
        }
      }
    }
    return device.platformName;
  }

  void _onConnectionState(BluetoothConnectionState state) {
    if (state != BluetoothConnectionState.disconnected) {
      return;
    }
    final wasConnected = _connected;
    if (!_intentionalDisconnect && wasConnected) {
      if (_shouldReconnect) {
        _error = null;
        _lastEvent = 'Conexión perdida; reconectando...';
      } else {
        _error = 'El nodo se desconectó';
        _lastEvent = null;
      }
    }
    _connected = false;
    _gpsRx = null;
    _peerTx = null;
    _statusChar = null;
    _textRx = null;
    _textTx = null;
    _status = null;
    _lastStatusAt = null;
    _statusSub?.cancel();
    _peerSub?.cancel();
    _textSub?.cancel();
    notifyListeners();
    if (wasConnected &&
        _shouldReconnect &&
        !_intentionalDisconnect &&
        !_disposed) {
      _scheduleReconnect();
    }
  }

  void _scheduleReconnect() {
    if (!_shouldReconnect || _disposed || _reconnectTimer != null) {
      return;
    }
    const delays = [2, 5, 10, 20, 30];
    final index = _reconnectAttempt < delays.length
        ? _reconnectAttempt
        : delays.length - 1;
    final delay = Duration(seconds: delays[index]);
    _reconnectAttempt++;
    _lastEvent = 'Reconectando en ${delay.inSeconds} s...';
    notifyListeners();
    _reconnectTimer = Timer(delay, () {
      _reconnectTimer = null;
      final target = _device;
      if (target == null || !_shouldReconnect || _disposed) {
        return;
      }
      unawaited(_connectTo(target, isReconnect: true));
    });
  }

  void _onStatus(List<int> value) {
    final parsed = LmStatus.tryParse(value);
    if (parsed == null) {
      return;
    }
    _status = parsed;
    _lastStatusAt = DateTime.now();
    notifyListeners();
  }

  void _onPeers(List<int> value) {
    final parsed = LmPeerSnapshot.tryParse(value);
    if (parsed == null) {
      return;
    }
    _peers = parsed.peers;
    notifyListeners();
  }

  void _onTextValue(List<int> value) {
    final text = LmTextMessage.tryParse(value);
    if (text != null) {
      _textController.add(text);
      return;
    }
    final ack = LmTextAck.tryParse(value);
    if (ack != null) {
      _textAckController.add(ack);
    }
  }

  Future<bool> writeGps(LmGpsPacket packet) async {
    if (!_connected || _gpsRx == null || _writeInFlight) {
      return false;
    }
    _writeInFlight = true;
    try {
      await _gpsRx!.write(packet.toBytes(), withoutResponse: true);
      return true;
    } catch (e) {
      _error = 'Envío BLE: $e';
      notifyListeners();
      return false;
    } finally {
      _writeInFlight = false;
    }
  }

  Future<LmTextMessage?> sendText({
    required String to,
    required String text,
    required bool broadcast,
  }) async {
    if (!_connected || _textRx == null || _textWriteInFlight) {
      return null;
    }
    final target = broadcast ? '*' : to.trim();
    if (target.isEmpty) {
      _error = 'Selecciona un destino';
      notifyListeners();
      return null;
    }
    if (utf8.encode(text).isEmpty ||
        utf8.encode(text).length > lmTextMaxBytes) {
      _error = 'El mensaje debe tener entre 1 y $lmTextMaxBytes bytes UTF-8';
      notifyListeners();
      return null;
    }

    var msgId = _random.nextInt(0xFFFFFFFF);
    if (msgId == 0) {
      msgId = 1;
    }
    final packet = LmTextMessage(
      msgId: msgId,
      sentAt: DateTime.now().millisecondsSinceEpoch ~/ 1000,
      from: _status?.nodeId ?? '',
      to: target,
      fromBootId: _status?.bootId ?? 0,
      flags: broadcast ? lmTextFlagBroadcast : 0,
      text: text,
    );

    _textWriteInFlight = true;
    try {
      await _textRx!.write(packet.toBytes(), withoutResponse: true);
      _error = null;
      return packet;
    } catch (e) {
      _error = 'Envío de mensaje: $e';
      notifyListeners();
      return null;
    } finally {
      _textWriteInFlight = false;
    }
  }

  Future<void> disconnect() async {
    _shouldReconnect = false;
    _reconnectAttempt = 0;
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
    _intentionalDisconnect = true;
    try {
      await _connSub?.cancel();
      await _statusSub?.cancel();
      await _peerSub?.cancel();
      await _textSub?.cancel();
      _connSub = null;
      _statusSub = null;
      _peerSub = null;
      _textSub = null;
      final d = _device;
      if (d != null && d.isConnected) {
        await d.disconnect();
      }
    } catch (_) {
    } finally {
      await _cleanupConnection();
      _intentionalDisconnect = false;
      _lastEvent = 'Desconectado';
      notifyListeners();
    }
  }

  Future<void> _cleanupConnection() async {
    _connected = false;
    _gpsRx = null;
    _peerTx = null;
    _statusChar = null;
    _textRx = null;
    _textTx = null;
    await _textSub?.cancel();
    _textSub = null;
    _mtu = 23;
    _peers = const [];
    notifyListeners();
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
    _shouldReconnect = false;
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
    _adapterSub?.cancel();
    _scanSub?.cancel();
    _scanStateSub?.cancel();
    _connSub?.cancel();
    _statusSub?.cancel();
    _peerSub?.cancel();
    _textSub?.cancel();
    _textController.close();
    _textAckController.close();
    final d = _device;
    if (d != null && d.isConnected) {
      d.disconnect();
    }
    super.dispose();
  }
}
