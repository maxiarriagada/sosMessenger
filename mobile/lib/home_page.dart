import 'dart:async';
import 'dart:math' as math;

import 'package:flutter_blue_plus/flutter_blue_plus.dart';
import 'package:material_ui/material_ui.dart';
import 'package:geolocator/geolocator.dart';

import 'ble/lm_ble_service.dart';
import 'ble/lm_packets.dart';
import 'chat/lm_chat_page.dart';
import 'chat/lm_chat_store.dart';
import 'services/lm_location_service.dart';
import 'services/lm_permissions.dart';

class LmHomePage extends StatefulWidget {
  const LmHomePage({super.key});

  @override
  State<LmHomePage> createState() => _LmHomePageState();
}

class _LmHomePageState extends State<LmHomePage> {
  final _ble = LmBleService()..init();
  final _location = LmLocationService();
  final _chat = LmChatStore();
  StreamSubscription<LmTextMessage>? _textSub;
  StreamSubscription<LmTextAck>? _textAckSub;

  bool _background = false;
  bool _streaming = false;
  bool _sending = false;
  int _tab = 0;
  int _seq = 0;
  int _sentCount = 0;
  DateTime? _lastSent;
  Position? _lastFix;
  String? _gpsError;

  @override
  void initState() {
    super.initState();
    unawaited(_chat.load());
    _textSub = _ble.textMessages.listen(_chat.addIncoming);
    _textAckSub = _ble.textAcks.listen(_chat.applyAck);
  }

  @override
  void dispose() {
    _textSub?.cancel();
    _textAckSub?.cancel();
    _chat.dispose();
    _location.stop();
    _ble.dispose();
    super.dispose();
  }

  Future<void> _scan() async {
    final granted = await LmPermissions.ensureBle();
    if (!mounted) {
      return;
    }
    if (!granted) {
      _showMessage('Faltan permisos de Bluetooth o ubicación');
      return;
    }
    await _ble.startScan();
  }

  Future<void> _connect(ScanResult result) async {
    final granted = await LmPermissions.ensureBle();
    if (!mounted) {
      return;
    }
    if (!granted) {
      _showMessage('Faltan permisos de Bluetooth o ubicación');
      return;
    }
    await _ble.connect(result.device);
    if (!mounted) {
      return;
    }
    final error = _ble.error;
    if (error != null) {
      _showMessage(error);
    }
  }

  Future<void> _startGps() async {
    final foreground = await LmPermissions.ensureLocation(background: false);
    if (!mounted) {
      return;
    }
    if (!foreground) {
      _showMessage('Permiso de ubicación denegado');
      return;
    }

    var background = _background;
    if (background) {
      final always = await LmPermissions.ensureLocation(background: true);
      if (!mounted) {
        return;
      }
      if (!always) {
        background = false;
        setState(() => _background = false);
        _showMessage('Sin permiso de segundo plano; GPS en primer plano');
      }
    }

    final started = await _location.start(
      background: background,
      onPosition: _onPosition,
      onError: (error) {
        if (mounted) {
          setState(() => _gpsError = '$error');
        }
      },
    );
    if (!mounted) {
      return;
    }
    if (!started) {
      setState(() => _gpsError = _location.error);
      _showMessage(_location.error ?? 'No se pudo iniciar el GPS');
      return;
    }
    setState(() {
      _streaming = true;
      _gpsError = null;
    });
  }

  Future<void> _stopGps() async {
    await _location.stop();
    if (mounted) {
      setState(() => _streaming = false);
    }
  }

  Future<void> _setBackground(bool value) async {
    setState(() => _background = value);
    if (_streaming) {
      await _startGps();
    }
  }

  Future<void> _onPosition(Position position) async {
    if (!mounted) {
      return;
    }
    setState(() => _lastFix = position);
    if (!_ble.connected || _sending) {
      return;
    }
    _sending = true;
    final age = DateTime.now().difference(position.timestamp).inMilliseconds;
    final packet = LmGpsPacket(
      seq: _seq++,
      lat: position.latitude,
      lon: position.longitude,
      accuracy: position.accuracy,
      altitudeM: position.altitude.round(),
      fixAgeMs: age.clamp(0, 65535),
      satellites: 0,
      valid: true,
    );
    final sent = await _ble.writeGps(packet);
    _sending = false;
    if (mounted && sent) {
      setState(() {
        _sentCount++;
        _lastSent = DateTime.now();
      });
    }
  }

  void _showMessage(String message) {
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(message)));
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _ble,
      builder: (context, _) {
        return Scaffold(
          appBar: AppBar(
            title: const Text('LoRa Messenger'),
            actions: [
              if (_ble.connected)
                IconButton(
                  tooltip: 'Desconectar',
                  onPressed: _ble.disconnect,
                  icon: const Icon(Icons.bluetooth_disabled),
                ),
            ],
          ),
          body: IndexedStack(
            index: _tab,
            children: [
              ListView(
                padding: const EdgeInsets.fromLTRB(16, 8, 16, 96),
                children: [
                  if (!_ble.adapterOn) _adapterBanner(),
                  _connectionCard(),
                  if (!_ble.connected) _scanCard(),
                  if (_ble.connected) _nodeCard(),
                  _gpsCard(),
                  _peersCard(),
                  _eventCard(),
                ],
              ),
              LmChatPage(ble: _ble, store: _chat, showMessage: _showMessage),
            ],
          ),
          floatingActionButton: _tab == 0 && !_ble.connected
              ? FloatingActionButton.extended(
                  onPressed: _ble.isScanning ? _ble.stopScan : _scan,
                  icon: Icon(_ble.isScanning ? Icons.stop : Icons.search),
                  label: Text(_ble.isScanning ? 'Detener' : 'Buscar nodo'),
                )
              : null,
          bottomNavigationBar: NavigationBar(
            selectedIndex: _tab,
            onDestinationSelected: (value) => setState(() => _tab = value),
            destinations: const [
              NavigationDestination(
                icon: Icon(Icons.dashboard_outlined),
                selectedIcon: Icon(Icons.dashboard),
                label: 'Monitor',
              ),
              NavigationDestination(
                icon: Icon(Icons.chat_bubble_outline),
                selectedIcon: Icon(Icons.chat_bubble),
                label: 'Mensajes',
              ),
            ],
          ),
        );
      },
    );
  }

  Widget _adapterBanner() {
    return Card(
      color: Theme.of(context).colorScheme.errorContainer,
      child: ListTile(
        leading: const Icon(Icons.bluetooth_disabled),
        title: const Text('Bluetooth apagado'),
        subtitle: Text('Estado: ${_ble.adapterState.name}'),
      ),
    );
  }

  Widget _connectionCard() {
    final scheme = Theme.of(context).colorScheme;
    final connected = _ble.connected;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(
                  connected ? Icons.bluetooth_connected : Icons.bluetooth,
                  color: connected ? scheme.primary : scheme.outline,
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        connected
                            ? (_ble.status?.nodeId.isNotEmpty == true
                                  ? _ble.status!.nodeId
                                  : _ble.deviceName)
                            : 'Sin conexión',
                        style: Theme.of(context).textTheme.titleMedium,
                      ),
                      Text(
                        connected
                            ? 'MTU ${_ble.mtu} · ${_ble.device?.remoteId ?? ''}'
                            : _ble.reconnecting
                            ? 'Reconectando automáticamente...'
                            : 'Conecta el nodo LM por BLE',
                        style: Theme.of(context).textTheme.bodySmall,
                      ),
                    ],
                  ),
                ),
                if (_ble.connecting || _ble.reconnecting)
                  const SizedBox(
                    width: 22,
                    height: 22,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  ),
              ],
            ),
            if (_ble.error != null) ...[
              const SizedBox(height: 12),
              Text(_ble.error!, style: TextStyle(color: scheme.error)),
            ],
          ],
        ),
      ),
    );
  }

  Widget _scanCard() {
    final results = _ble.scanResults;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'Nodos encontrados',
              style: Theme.of(context).textTheme.titleMedium,
            ),
            const SizedBox(height: 8),
            if (_ble.isScanning) const LinearProgressIndicator(minHeight: 2),
            if (results.isEmpty)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 16),
                child: Text('Sin nodos LM-* todavía. Pulsa Buscar nodo.'),
              )
            else
              ...results.map(
                (result) => ListTile(
                  contentPadding: EdgeInsets.zero,
                  leading: const Icon(Icons.memory),
                  title: Text(_ble.nameOf(result)),
                  subtitle: Text(
                    '${result.device.remoteId} · RSSI ${result.rssi} dBm',
                  ),
                  trailing: FilledButton(
                    onPressed: () => _connect(result),
                    child: const Text('Conectar'),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }

  Widget _nodeCard() {
    final status = _ble.status;
    if (status == null) {
      return const Card(
        child: ListTile(
          leading: CircularProgressIndicator(),
          title: Text('Esperando status del nodo...'),
        ),
      );
    }
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(
                    'Estado del nodo',
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                ),
                _pill(
                  status.hasFix ? 'FIX' : 'SIN FIX',
                  status.hasFix
                      ? Theme.of(context).colorScheme.primary
                      : Theme.of(context).colorScheme.error,
                ),
              ],
            ),
            const SizedBox(height: 12),
            _infoRow('ID', status.nodeId),
            _infoRow('Origen GPS', lmSourceName(status.gpsSource)),
            _infoRow('Satélites', '${status.satellites}'),
            _infoRow('Edad fix', _ms(status.fixAgeMs)),
            _infoRow('Peers', '${status.peerCount}'),
            _infoRow('Uptime', _uptime(status.uptimeS)),
            _infoRow('Secuencia', '${status.seq}'),
            if (status.hasFix) ...[
              const Divider(height: 24),
              _infoRow(
                'Ubicación',
                '${status.lat.toStringAsFixed(6)}, ${status.lon.toStringAsFixed(6)}',
              ),
              _infoRow(
                'Precisión',
                '${status.accuracy.toStringAsFixed(1)} m · ${status.altitudeM} m',
              ),
            ],
            if (_ble.lastStatusAt != null)
              _infoRow('Actualizado', _time(_ble.lastStatusAt)),
          ],
        ),
      ),
    );
  }

  Widget _gpsCard() {
    final fix = _lastFix;
    final scheme = Theme.of(context).colorScheme;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(
                    'GPS del teléfono',
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                ),
                _pill(
                  _streaming ? 'ACTIVO' : 'DETENIDO',
                  _streaming ? scheme.primary : scheme.outline,
                ),
              ],
            ),
            SwitchListTile(
              contentPadding: EdgeInsets.zero,
              title: const Text('Segundo plano'),
              subtitle: const Text(
                'Servicio en primer plano y permiso "Siempre"',
              ),
              value: _background,
              onChanged: _setBackground,
            ),
            const SizedBox(height: 4),
            Row(
              children: [
                FilledButton.icon(
                  onPressed: _streaming ? _stopGps : _startGps,
                  icon: Icon(_streaming ? Icons.stop : Icons.my_location),
                  label: Text(_streaming ? 'Detener GPS' : 'Iniciar GPS'),
                ),
                const SizedBox(width: 12),
                if (_background)
                  TextButton(
                    onPressed: LmPermissions.openSettings,
                    child: const Text('Ajustes'),
                  ),
              ],
            ),
            const SizedBox(height: 12),
            if (fix != null) ...[
              _infoRow(
                'Posición',
                '${fix.latitude.toStringAsFixed(6)}, ${fix.longitude.toStringAsFixed(6)}',
              ),
              _infoRow(
                'Precisión',
                '${fix.accuracy.toStringAsFixed(1)} m · ${fix.altitude.toStringAsFixed(0)} m',
              ),
              _infoRow(
                'Edad',
                '${DateTime.now().difference(fix.timestamp).inSeconds} s',
              ),
              _infoRow('Enviados', '$_sentCount'),
              _infoRow('Último envío', _time(_lastSent)),
            ] else
              const Text('Sin posición todavía.'),
            if (_gpsError != null) ...[
              const SizedBox(height: 8),
              Text(_gpsError!, style: TextStyle(color: scheme.error)),
            ],
            if (_streaming && !_ble.connected) ...[
              const SizedBox(height: 8),
              Text(
                'El GPS está activo, pero no hay nodo BLE conectado.',
                style: TextStyle(color: scheme.tertiary),
              ),
            ],
          ],
        ),
      ),
    );
  }

  Widget _peersCard() {
    final peers = _ble.peers;
    final ownLat = _lastFix?.latitude ?? _ble.status?.lat;
    final ownLon = _lastFix?.longitude ?? _ble.status?.lon;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'Peers vía hub (${peers.length})',
              style: Theme.of(context).textTheme.titleMedium,
            ),
            const SizedBox(height: 8),
            if (peers.isEmpty)
              const Text('Sin peers en el snapshot del hub.')
            else
              ...peers.map(
                (peer) => ListTile(
                  contentPadding: EdgeInsets.zero,
                  leading: Icon(
                    peer.hasFix ? Icons.place : Icons.location_off,
                    color: peer.hasFix
                        ? Theme.of(context).colorScheme.primary
                        : Theme.of(context).colorScheme.outline,
                  ),
                  title: Text(peer.id),
                  subtitle: Text(
                    [
                      lmSourceName(peer.gpsSource),
                      '${peer.satellites} sat',
                      '${peer.rssi} dBm',
                      'edad ${peer.ageS} s',
                      if (peer.hasFix && ownLat != null && ownLon != null)
                        _distanceLabel(ownLat, ownLon, peer.lat, peer.lon),
                    ].join(' · '),
                  ),
                  trailing: peer.hasFix
                      ? Text(
                          '${peer.lat.toStringAsFixed(4)}\n${peer.lon.toStringAsFixed(4)}',
                          textAlign: TextAlign.right,
                          style: Theme.of(context).textTheme.bodySmall,
                        )
                      : null,
                ),
              ),
          ],
        ),
      ),
    );
  }

  Widget _eventCard() {
    final text = _ble.lastEvent ?? 'Listo';
    return Card(
      child: ListTile(
        leading: const Icon(Icons.terminal),
        title: const Text('Evento'),
        subtitle: Text(text),
      ),
    );
  }

  Widget _pill(String text, Color color) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.15),
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: color),
      ),
      child: Text(
        text,
        style: TextStyle(
          color: color,
          fontSize: 12,
          fontWeight: FontWeight.w600,
        ),
      ),
    );
  }

  Widget _infoRow(String label, String value) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 104,
            child: Text(label, style: Theme.of(context).textTheme.bodySmall),
          ),
          Expanded(child: Text(value)),
        ],
      ),
    );
  }

  String _distanceLabel(double lat1, double lon1, double lat2, double lon2) {
    final meters = _distanceMeters(lat1, lon1, lat2, lon2);
    if (meters >= 1000) {
      return '${(meters / 1000).toStringAsFixed(2)} km';
    }
    return '${meters.toStringAsFixed(0)} m';
  }

  double _distanceMeters(double lat1, double lon1, double lat2, double lon2) {
    const earth = 6371000.0;
    final dLat = _rad(lat2 - lat1);
    final dLon = _rad(lon2 - lon1);
    final a =
        math.sin(dLat / 2) * math.sin(dLat / 2) +
        math.cos(_rad(lat1)) *
            math.cos(_rad(lat2)) *
            math.sin(dLon / 2) *
            math.sin(dLon / 2);
    return earth * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a));
  }

  double _rad(double degrees) => degrees * math.pi / 180.0;

  String _ms(int value) {
    if (value >= 1000) {
      return '${(value / 1000).toStringAsFixed(1)} s';
    }
    return '$value ms';
  }

  String _uptime(int seconds) {
    final h = seconds ~/ 3600;
    final m = (seconds % 3600) ~/ 60;
    final s = seconds % 60;
    if (h > 0) {
      return '${h}h ${m}m';
    }
    if (m > 0) {
      return '${m}m ${s}s';
    }
    return '${s}s';
  }

  String _time(DateTime? value) {
    if (value == null) {
      return '—';
    }
    final local = value.toLocal();
    return '${local.hour.toString().padLeft(2, '0')}:'
        '${local.minute.toString().padLeft(2, '0')}:'
        '${local.second.toString().padLeft(2, '0')}';
  }
}
