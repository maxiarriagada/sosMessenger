import 'dart:async';
import 'dart:io';

import 'package:geolocator/geolocator.dart';

class LmLocationService {
  StreamSubscription<Position>? _sub;
  Position? _lastPosition;
  String? _error;
  bool _streaming = false;
  bool _background = false;

  Position? get lastPosition => _lastPosition;
  String? get error => _error;
  bool get streaming => _streaming;
  bool get background => _background;

  Future<bool> start({
    required bool background,
    required void Function(Position position) onPosition,
    required void Function(Object error) onError,
  }) async {
    await stop();
    _error = null;
    _background = background;

    final serviceEnabled = await Geolocator.isLocationServiceEnabled();
    if (!serviceEnabled) {
      _error = 'El GPS del teléfono está desactivado';
      return false;
    }

    final settings = Platform.isAndroid
        ? AndroidSettings(
            accuracy: LocationAccuracy.high,
            distanceFilter: 0,
            intervalDuration: const Duration(seconds: 2),
            foregroundNotificationConfig: const ForegroundNotificationConfig(
              notificationTitle: 'LoRa Messenger GPS activo',
              notificationText: 'Enviando ubicación al nodo LM',
              notificationChannelName: 'LM GPS',
              enableWakeLock: true,
              setOngoing: true,
            ),
          )
        : AppleSettings(
            accuracy: LocationAccuracy.high,
            distanceFilter: 0,
            activityType: ActivityType.other,
            pauseLocationUpdatesAutomatically: false,
            showBackgroundLocationIndicator: background,
            allowBackgroundLocationUpdates: background,
          );

    try {
      _sub = Geolocator.getPositionStream(locationSettings: settings).listen(
        (position) {
          _lastPosition = position;
          onPosition(position);
        },
        onError: (Object e) {
          _error = 'GPS: $e';
          onError(e);
        },
        cancelOnError: false,
      );
      _streaming = true;
      return true;
    } catch (e) {
      _error = 'GPS: $e';
      onError(e);
      return false;
    }
  }

  Future<void> stop() async {
    await _sub?.cancel();
    _sub = null;
    _streaming = false;
  }
}
