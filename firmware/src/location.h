#pragma once

#include <Arduino.h>
#include <ArduinoJson.h>
#include <IPAddress.h>

#include "radio_protocol.h"

enum class LocationResult : uint8_t {
  Ok = 0,
  InvalidInput,
  NotFound,
  RateLimited,
  InternalError,
};

void locationBegin();
void locationLoop();

String locationSelectedSource();
LocationResult locationSetSelectedSource(const String &source,
                                         String &messageOut);

LocationResult locationSetManual(double lat, double lon, float accuracy,
                                 String &messageOut);

LocationResult locationUpdatePhone(const String &clientId, const String &label,
                                   const IPAddress &ip, const String &userAgent,
                                   bool hasFix, double lat, double lon,
                                   float accuracy, uint32_t &retryAfterOut,
                                   String &messageOut);

LocationResult locationUpdateNode(const String &nodeId, bool hasFix, double lat,
                                  double lon, float accuracy,
                                  uint8_t satellites, uint8_t gpsSource,
                                  uint32_t uptimeS, uint32_t seq,
                                  uint16_t bootId, uint16_t fixAgeMs,
                                  int8_t rssi, String &messageOut);

void locationFillRadioSnapshot(RadioPeerSnapshot &snapshot);

LocationResult locationCreateRequest(const String &target,
                                     const String &requestedBy,
                                     String &messageOut);

LocationResult locationClear(const String &source, String &messageOut);

void locationFillState(JsonObject root, const String &clientId);
