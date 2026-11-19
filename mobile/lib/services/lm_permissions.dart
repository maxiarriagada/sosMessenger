import 'dart:io';

import 'package:permission_handler/permission_handler.dart';

class LmPermissions {
  static Future<bool> ensureBle() async {
    final permissions = <Permission>[
      if (Platform.isAndroid) Permission.bluetoothScan,
      if (Platform.isAndroid) Permission.bluetoothConnect,
      if (Platform.isIOS) Permission.bluetooth,
      Permission.locationWhenInUse,
    ];
    final statuses = await permissions.request();
    return statuses.values.every((status) => status.isGranted);
  }

  static Future<bool> ensureLocation({required bool background}) async {
    var foreground = await Permission.locationWhenInUse.status;
    if (!foreground.isGranted) {
      foreground = await Permission.locationWhenInUse.request();
    }
    if (!foreground.isGranted) {
      return false;
    }

    if (Platform.isAndroid) {
      await Permission.notification.request();
    }

    if (!background) {
      return true;
    }

    var always = await Permission.locationAlways.status;
    if (!always.isGranted) {
      always = await Permission.locationAlways.request();
    }
    return always.isGranted;
  }

  static Future<bool> backgroundLocationGranted() async {
    final status = await Permission.locationAlways.status;
    return status.isGranted;
  }

  static Future<bool> openSettings() => openAppSettings();
}
