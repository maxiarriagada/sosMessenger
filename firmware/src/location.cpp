#include "location.h"

#include <Preferences.h>
#include <math.h>
#include <string.h>

#include "app_lock.h"
#include "config.h"

namespace {

struct LocationFix {
  bool valid = false;
  double lat = 0;
  double lon = 0;
  float accuracy = 0;
  uint32_t at = 0;
  String source;
  String label;
};

struct PhoneEntry {
  bool used = false;
  String id;
  String label;
  IPAddress ip;
  String userAgent;
  uint32_t lastSeenAt = 0;
  uint32_t lastSubmitAt = 0;
  LocationFix fix;
};

struct NodeEntry {
  bool used = false;
  String id;
  uint32_t lastSeenAt = 0;
  uint8_t satellites = 0;
  uint8_t gpsSource = LM_RADIO_GPS_UNKNOWN;
  uint16_t bootId = 0;
  uint16_t fixAgeMs = 0;
  int8_t rssi = 0;
  uint32_t uptimeS = 0;
  uint32_t seq = 0;
  LocationFix fix;
};

struct LocationRequest {
  bool active = false;
  uint32_t id = 0;
  String target;
  String requestedBy;
  uint32_t startedAt = 0;
};

struct ResolvedLocation {
  bool valid = false;
  bool stale = false;
  LocationFix fix;
};

LocationFix g_manual;
PhoneEntry g_phones[LM_PHONE_MAX];
NodeEntry g_nodes[LM_NODE_MAX];
LocationRequest g_request;
String g_selected = "auto";
uint32_t g_requestSeq = 0;

bool validLat(double lat) {
  return !isnan(lat) && !isinf(lat) && lat >= -90.0 && lat <= 90.0;
}

bool validLon(double lon) {
  return !isnan(lon) && !isinf(lon) && lon >= -180.0 && lon <= 180.0;
}

bool validAccuracy(float accuracy) {
  return !isnan(accuracy) && !isinf(accuracy) && accuracy >= 0 &&
         accuracy <= 1000000;
}

bool validId(const String &id, size_t minLen, size_t maxLen) {
  if (id.length() < minLen || id.length() > maxLen) {
    return false;
  }
  for (size_t i = 0; i < id.length(); i++) {
    const char c = id.charAt(i);
    const bool ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
                    (c >= '0' && c <= '9') || c == '_' || c == '-';
    if (!ok) {
      return false;
    }
  }
  return true;
}

bool validLabel(const String &label) {
  if (label.length() > LM_PHONE_LABEL_MAX) {
    return false;
  }
  for (size_t i = 0; i < label.length(); i++) {
    const unsigned char c = (unsigned char)label.charAt(i);
    if (c < 0x20 || c == 0x7F) {
      return false;
    }
  }
  return true;
}

bool isPhoneSource(const String &source) {
  return source.startsWith("phone:");
}

bool isNodeSource(const String &source) {
  return source.startsWith("node:");
}

bool validSource(const String &source) {
  if (source == "auto" || source == "manual" || source == "hub_gps") {
    return true;
  }
  if (isPhoneSource(source)) {
    return validId(source.substring(6), LM_PHONE_ID_MIN, LM_PHONE_ID_MAX);
  }
  if (isNodeSource(source)) {
    return validId(source.substring(5), 1, LM_NODE_ID_MAX);
  }
  return false;
}

void clearFix(LocationFix &fix) {
  fix.valid = false;
  fix.lat = 0;
  fix.lon = 0;
  fix.accuracy = 0;
  fix.at = 0;
  fix.source = String();
  fix.label = String();
}

void clearPhone(PhoneEntry &phone) {
  phone.used = false;
  phone.id = String();
  phone.label = String();
  phone.ip = IPAddress();
  phone.userAgent = String();
  phone.lastSeenAt = 0;
  phone.lastSubmitAt = 0;
  clearFix(phone.fix);
}

void clearNode(NodeEntry &node) {
  node.used = false;
  node.id = String();
  node.lastSeenAt = 0;
  node.satellites = 0;
  node.gpsSource = LM_RADIO_GPS_UNKNOWN;
  node.bootId = 0;
  node.fixAgeMs = 0;
  node.rssi = 0;
  node.uptimeS = 0;
  node.seq = 0;
  clearFix(node.fix);
}

PhoneEntry *findPhone(const String &id) {
  for (size_t i = 0; i < LM_PHONE_MAX; i++) {
    if (g_phones[i].used && g_phones[i].id == id) {
      return &g_phones[i];
    }
  }
  return nullptr;
}

PhoneEntry *allocatePhone(uint32_t now) {
  PhoneEntry *oldest = &g_phones[0];
  for (size_t i = 0; i < LM_PHONE_MAX; i++) {
    if (!g_phones[i].used) {
      clearPhone(g_phones[i]);
      g_phones[i].used = true;
      return &g_phones[i];
    }
    if ((int32_t)(g_phones[i].lastSeenAt - oldest->lastSeenAt) < 0) {
      oldest = &g_phones[i];
    }
  }
  clearPhone(*oldest);
  oldest->used = true;
  oldest->lastSeenAt = now;
  return oldest;
}

NodeEntry *findNode(const String &id) {
  for (size_t i = 0; i < LM_NODE_MAX; i++) {
    if (g_nodes[i].used && g_nodes[i].id == id) {
      return &g_nodes[i];
    }
  }
  return nullptr;
}

NodeEntry *allocateNode(uint32_t now) {
  NodeEntry *oldest = &g_nodes[0];
  for (size_t i = 0; i < LM_NODE_MAX; i++) {
    if (!g_nodes[i].used) {
      clearNode(g_nodes[i]);
      g_nodes[i].used = true;
      return &g_nodes[i];
    }
    if ((int32_t)(g_nodes[i].lastSeenAt - oldest->lastSeenAt) < 0) {
      oldest = &g_nodes[i];
    }
  }
  clearNode(*oldest);
  oldest->used = true;
  oldest->lastSeenAt = now;
  return oldest;
}

uint32_t ageSeconds(uint32_t now, uint32_t at) {
  return (uint32_t)(now - at) / 1000UL;
}

bool isStale(uint32_t now, uint32_t at) {
  return (uint32_t)(now - at) >= LM_LOCATION_STALE_MS;
}

void prunePhones(uint32_t now) {
  for (size_t i = 0; i < LM_PHONE_MAX; i++) {
    if (g_phones[i].used &&
        (uint32_t)(now - g_phones[i].lastSeenAt) >= LM_PHONE_PRUNE_MS) {
      clearPhone(g_phones[i]);
    }
  }
}

void pruneNodes(uint32_t now) {
  for (size_t i = 0; i < LM_NODE_MAX; i++) {
    if (g_nodes[i].used &&
        (uint32_t)(now - g_nodes[i].lastSeenAt) >= LM_NODE_PRUNE_MS) {
      clearNode(g_nodes[i]);
    }
  }
}

NodeEntry *latestNode() {
  NodeEntry *best = nullptr;
  for (size_t i = 0; i < LM_NODE_MAX; i++) {
    NodeEntry &node = g_nodes[i];
    if (!node.used) {
      continue;
    }
    if (best == nullptr ||
        (int32_t)(node.lastSeenAt - best->lastSeenAt) > 0) {
      best = &node;
    }
  }
  return best;
}

void expireRequest(uint32_t now) {
  if (g_request.active &&
      (uint32_t)(now - g_request.startedAt) >= LM_LOCATION_REQUEST_MS) {
    g_request.active = false;
    g_request.target = String();
    g_request.requestedBy = String();
  }
}

String sourceLabel(const String &source) {
  if (source == "auto") {
    return "Automático";
  }
  if (source == "manual") {
    return "Manual";
  }
  if (source == "hub_gps") {
    return "GPS del hub";
  }
  if (isPhoneSource(source)) {
    PhoneEntry *phone = findPhone(source.substring(6));
    if (phone != nullptr && phone->label.length() > 0) {
      return phone->label;
    }
  }
  if (isNodeSource(source)) {
    NodeEntry *node = findNode(source.substring(5));
    if (node != nullptr && node->fix.label.length() > 0) {
      return node->fix.label;
    }
    return String("Nodo ") + source.substring(5);
  }
  return source;
}

void copyFix(ResolvedLocation &out, const LocationFix &fix, uint32_t now) {
  out.valid = true;
  out.fix = fix;
  out.stale = isStale(now, fix.at);
}

ResolvedLocation resolveSelected(uint32_t now) {
  ResolvedLocation out;

  if (g_selected == "auto") {
    NodeEntry *bestNode = nullptr;
    for (size_t i = 0; i < LM_NODE_MAX; i++) {
      NodeEntry &node = g_nodes[i];
      if (!node.used || !node.fix.valid || isStale(now, node.fix.at)) {
        continue;
      }
      if (bestNode == nullptr ||
          (int32_t)(node.fix.at - bestNode->fix.at) > 0) {
        bestNode = &node;
      }
    }
    if (bestNode != nullptr) {
      copyFix(out, bestNode->fix, now);
      return out;
    }

    PhoneEntry *best = nullptr;
    for (size_t i = 0; i < LM_PHONE_MAX; i++) {
      PhoneEntry &phone = g_phones[i];
      if (!phone.used || !phone.fix.valid || isStale(now, phone.fix.at)) {
        continue;
      }
      if (best == nullptr ||
          (int32_t)(phone.fix.at - best->fix.at) > 0) {
        best = &phone;
      }
    }
    if (best != nullptr) {
      copyFix(out, best->fix, now);
    }
    return out;
  }

  if (g_selected == "manual") {
    if (g_manual.valid) {
      copyFix(out, g_manual, now);
    }
    return out;
  }

  if (isPhoneSource(g_selected)) {
    PhoneEntry *phone = findPhone(g_selected.substring(6));
    if (phone != nullptr && phone->fix.valid) {
      copyFix(out, phone->fix, now);
    }
  }

  if (isNodeSource(g_selected)) {
    NodeEntry *node = findNode(g_selected.substring(5));
    if (node != nullptr && node->fix.valid) {
      copyFix(out, node->fix, now);
    }
  }

  return out;
}

bool loadSelectedSource() {
  Preferences prefs;
  if (!prefs.begin("lm", true)) {
    return false;
  }
  String source = prefs.getString("loc_src", "auto");
  prefs.end();
  if (!validSource(source)) {
    source = "auto";
  }
  g_selected = source;
  return true;
}

bool saveSelectedSource(const String &source) {
  Preferences prefs;
  if (!prefs.begin("lm", false)) {
    Serial.println("[location] NVS write open failed");
    return false;
  }
  const size_t written = prefs.putString("loc_src", source);
  prefs.end();
  return written == source.length();
}

} // namespace

void locationBegin() {
  g_selected = "auto";
  g_requestSeq = 0;
  clearFix(g_manual);

  for (size_t i = 0; i < LM_PHONE_MAX; i++) {
    clearPhone(g_phones[i]);
  }

  for (size_t i = 0; i < LM_NODE_MAX; i++) {
    clearNode(g_nodes[i]);
  }

  g_request.active = false;
  g_request.id = 0;
  g_request.target = String();
  g_request.requestedBy = String();
  g_request.startedAt = 0;

  loadSelectedSource();
  Serial.printf("[location] source=%s\n", g_selected.c_str());
}

void locationLoop() {
  AppLock lock(0);
  if (!lock.locked()) {
    return;
  }
  const uint32_t now = millis();
  prunePhones(now);
  pruneNodes(now);
  expireRequest(now);
}

String locationSelectedSource() { return g_selected; }

LocationResult locationSetSelectedSource(const String &source,
                                         String &messageOut) {
  messageOut = "";
  String value = source;
  value.trim();

  if (!validSource(value)) {
    messageOut = "fuente de ubicacion invalida";
    return LocationResult::InvalidInput;
  }

  if (isPhoneSource(value) && findPhone(value.substring(6)) == nullptr) {
    messageOut = "el telefono no esta registrado";
    return LocationResult::NotFound;
  }

  if (isNodeSource(value) && findNode(value.substring(5)) == nullptr) {
    messageOut = "el nodo no esta registrado";
    return LocationResult::NotFound;
  }

  if (value != g_selected) {
    if (!saveSelectedSource(value)) {
      messageOut = "no se pudo guardar la fuente activa";
      return LocationResult::InternalError;
    }
    g_selected = value;
    Serial.printf("[location] selected=%s\n", g_selected.c_str());
  }

  return LocationResult::Ok;
}

LocationResult locationSetManual(double lat, double lon, float accuracy,
                                 String &messageOut) {
  messageOut = "";

  if (!validLat(lat) || !validLon(lon) || !validAccuracy(accuracy)) {
    messageOut = "coordenadas invalidas";
    return LocationResult::InvalidInput;
  }

  if (!saveSelectedSource("manual")) {
    messageOut = "no se pudo guardar la fuente activa";
    return LocationResult::InternalError;
  }

  g_selected = "manual";
  g_manual.valid = true;
  g_manual.lat = lat;
  g_manual.lon = lon;
  g_manual.accuracy = accuracy;
  g_manual.at = millis();
  g_manual.source = "manual";
  g_manual.label = "Manual";

  Serial.printf("[location] manual lat=%.6f lon=%.6f\n", lat, lon);
  return LocationResult::Ok;
}

LocationResult locationUpdatePhone(const String &clientId, const String &label,
                                   const IPAddress &ip, const String &userAgent,
                                   bool hasFix, double lat, double lon,
                                   float accuracy, uint32_t &retryAfterOut,
                                   String &messageOut) {
  retryAfterOut = 0;
  messageOut = "";

  String id = clientId;
  id.trim();
  if (!validId(id, LM_PHONE_ID_MIN, LM_PHONE_ID_MAX)) {
    messageOut = "client_id invalido";
    return LocationResult::InvalidInput;
  }

  String cleanLabel = label;
  cleanLabel.trim();
  if (!validLabel(cleanLabel)) {
    messageOut = "etiqueta invalida";
    return LocationResult::InvalidInput;
  }

  if (hasFix &&
      (!validLat(lat) || !validLon(lon) || !validAccuracy(accuracy))) {
    messageOut = "coordenadas invalidas";
    return LocationResult::InvalidInput;
  }

  const uint32_t now = millis();
  PhoneEntry *phone = findPhone(id);
  if (phone == nullptr) {
    phone = allocatePhone(now);
    if (phone == nullptr) {
      messageOut = "no hay espacio para mas telefonos";
      return LocationResult::InternalError;
    }
    phone->id = id;
    phone->label = cleanLabel.length() > 0 ? cleanLabel : String("Mi teléfono");
  } else if (cleanLabel.length() > 0) {
    phone->label = cleanLabel;
  }

  phone->ip = ip;
  String ua = userAgent;
  if (ua.length() > LM_LOCATION_UA_MAX) {
    ua = ua.substring(0, LM_LOCATION_UA_MAX);
  }
  phone->userAgent = ua;
  phone->lastSeenAt = now;

  if (!hasFix) {
    return LocationResult::Ok;
  }

  if (phone->lastSubmitAt != 0 &&
      (uint32_t)(now - phone->lastSubmitAt) < LM_PHONE_SUBMIT_MIN_MS) {
    const uint32_t elapsed = now - phone->lastSubmitAt;
    retryAfterOut = (LM_PHONE_SUBMIT_MIN_MS - elapsed + 999) / 1000;
    messageOut = "espera antes de enviar otra ubicacion";
    return LocationResult::RateLimited;
  }

  phone->fix.valid = true;
  phone->fix.lat = lat;
  phone->fix.lon = lon;
  phone->fix.accuracy = accuracy;
  phone->fix.at = now;
  phone->fix.source = String("phone:") + phone->id;
  phone->fix.label = phone->label;
  phone->lastSubmitAt = now;

  if (g_request.active &&
      (g_request.target == "auto" || g_request.target == phone->fix.source)) {
    g_request.active = false;
    g_request.target = String();
    g_request.requestedBy = String();
  }

  Serial.printf("[location] phone=%s lat=%.6f lon=%.6f\n", phone->id.c_str(),
                lat, lon);
  return LocationResult::Ok;
}

LocationResult locationUpdateNode(const String &nodeId, bool hasFix, double lat,
                                  double lon, float accuracy,
                                  uint8_t satellites, uint8_t gpsSource,
                                  uint32_t uptimeS, uint32_t seq,
                                  uint16_t bootId, uint16_t fixAgeMs,
                                  int8_t rssi, String &messageOut) {
  messageOut = "";

  String id = nodeId;
  id.trim();
  if (!validId(id, 1, LM_NODE_ID_MAX)) {
    messageOut = "node id invalido";
    return LocationResult::InvalidInput;
  }

  if (hasFix &&
      (!validLat(lat) || !validLon(lon) || !validAccuracy(accuracy))) {
    messageOut = "coordenadas invalidas";
    return LocationResult::InvalidInput;
  }

  const uint32_t now = millis();
  NodeEntry *node = findNode(id);
  if (node != nullptr && node->bootId == bootId &&
      (int32_t)(seq - node->seq) <= 0) {
    node->lastSeenAt = now;
    node->rssi = rssi;
    return LocationResult::Ok;
  }

  if (node == nullptr) {
    node = allocateNode(now);
    if (node == nullptr) {
      messageOut = "no hay espacio para mas nodos";
      return LocationResult::InternalError;
    }
    node->id = id;
  }

  node->lastSeenAt = now;
  node->satellites = satellites;
  node->gpsSource = gpsSource;
  node->bootId = bootId;
  node->fixAgeMs = fixAgeMs;
  node->rssi = rssi;
  node->uptimeS = uptimeS;
  node->seq = seq;

  if (!hasFix) {
    return LocationResult::Ok;
  }

  node->fix.valid = true;
  node->fix.lat = lat;
  node->fix.lon = lon;
  node->fix.accuracy = accuracy;
  node->fix.at = now;
  node->fix.source = String("node:") + node->id;
  node->fix.label = String("Nodo ") + node->id;

  Serial.printf("[location] node=%s src=%s rssi=%d lat=%.6f lon=%.6f sat=%u\n",
                node->id.c_str(), radioGpsSourceName(gpsSource), (int)rssi, lat,
                lon, (unsigned)satellites);
  return LocationResult::Ok;
}

void locationFillRadioSnapshot(RadioPeerSnapshot &snapshot) {
  const uint32_t now = millis();
  snapshot.magic = LM_RADIO_MAGIC;
  snapshot.version = LM_RADIO_VERSION;
  snapshot.type = LM_RADIO_TYPE_PEER_SNAPSHOT;
  snapshot.count = 0;
  snapshot.hubUptimeS = now / 1000UL;

  AppLock lock(100);
  if (!lock.locked()) {
    return;
  }

  for (size_t i = 0; i < LM_NODE_MAX; i++) {
    NodeEntry &node = g_nodes[i];
    if (!node.used) {
      continue;
    }

    RadioPeerEntry &peer = snapshot.peers[snapshot.count++];
    memset(&peer, 0, sizeof(peer));
    strncpy(peer.id, node.id.c_str(), sizeof(peer.id) - 1);
    peer.hasFix = node.fix.valid ? 1 : 0;
    peer.satellites = node.satellites;
    peer.gpsSource = node.gpsSource;
    peer.lat = (float)node.fix.lat;
    peer.lon = (float)node.fix.lon;
    peer.accuracy = node.fix.accuracy;
    peer.uptimeS = node.uptimeS;
    peer.seq = node.seq;
    peer.bootId = node.bootId;
    uint32_t seenAge = ageSeconds(now, node.lastSeenAt);
    if (seenAge > 65535UL) {
      seenAge = 65535UL;
    }
    peer.ageS = (uint16_t)seenAge;
    peer.rssi = node.rssi;

    if (node.fix.valid) {
      uint32_t fixAge =
          (uint32_t)(now - node.fix.at) + (uint32_t)node.fixAgeMs;
      if (fixAge > 65535UL) {
        fixAge = 65535UL;
      }
      peer.fixAgeMs = (uint16_t)fixAge;
    }

    if (snapshot.count >= LM_NODE_MAX) {
      break;
    }
  }
}

LocationResult locationCreateRequest(const String &target,
                                     const String &requestedBy,
                                     String &messageOut) {
  messageOut = "";
  String value = target;
  value.trim();

  if (value != "auto") {
    if (!isPhoneSource(value) ||
        !validId(value.substring(6), LM_PHONE_ID_MIN, LM_PHONE_ID_MAX)) {
      messageOut = "destino de solicitud invalido";
      return LocationResult::InvalidInput;
    }
    if (findPhone(value.substring(6)) == nullptr) {
      messageOut = "el telefono no esta registrado";
      return LocationResult::NotFound;
    }
  }

  g_requestSeq++;
  if (g_requestSeq == 0) {
    g_requestSeq = 1;
  }

  g_request.active = true;
  g_request.id = g_requestSeq;
  g_request.target = value;
  g_request.requestedBy = requestedBy;
  if (g_request.requestedBy.length() > LM_USERNAME_MAX) {
    g_request.requestedBy = g_request.requestedBy.substring(0, LM_USERNAME_MAX);
  }
  g_request.startedAt = millis();

  Serial.printf("[location] request target=%s\n", g_request.target.c_str());
  return LocationResult::Ok;
}

LocationResult locationClear(const String &source, String &messageOut) {
  messageOut = "";
  String value = source;
  value.trim();

  if (value == "all") {
    if (g_selected != "auto" && !saveSelectedSource("auto")) {
      messageOut = "no se pudo guardar la fuente activa";
      return LocationResult::InternalError;
    }
    g_selected = "auto";
    clearFix(g_manual);
    for (size_t i = 0; i < LM_PHONE_MAX; i++) {
      clearPhone(g_phones[i]);
    }
    for (size_t i = 0; i < LM_NODE_MAX; i++) {
      clearNode(g_nodes[i]);
    }
    g_request.active = false;
    g_request.target = String();
    g_request.requestedBy = String();
    return LocationResult::Ok;
  }

  if (value == "manual") {
    clearFix(g_manual);
    return LocationResult::Ok;
  }

  if (isPhoneSource(value) &&
      validId(value.substring(6), LM_PHONE_ID_MIN, LM_PHONE_ID_MAX)) {
    PhoneEntry *phone = findPhone(value.substring(6));
    if (phone == nullptr) {
      messageOut = "el telefono no esta registrado";
      return LocationResult::NotFound;
    }
    if (g_selected == value) {
      if (!saveSelectedSource("auto")) {
        messageOut = "no se pudo guardar la fuente activa";
        return LocationResult::InternalError;
      }
      g_selected = "auto";
    }
    if (g_request.active && g_request.target == value) {
      g_request.active = false;
      g_request.target = String();
      g_request.requestedBy = String();
    }
    clearPhone(*phone);
    return LocationResult::Ok;
  }

  if (isNodeSource(value) &&
      validId(value.substring(5), 1, LM_NODE_ID_MAX)) {
    NodeEntry *node = findNode(value.substring(5));
    if (node == nullptr) {
      messageOut = "el nodo no esta registrado";
      return LocationResult::NotFound;
    }
    if (g_selected == value) {
      if (!saveSelectedSource("auto")) {
        messageOut = "no se pudo guardar la fuente activa";
        return LocationResult::InternalError;
      }
      g_selected = "auto";
    }
    if (g_request.active && g_request.target == value) {
      g_request.active = false;
      g_request.target = String();
      g_request.requestedBy = String();
    }
    clearNode(*node);
    return LocationResult::Ok;
  }

  messageOut = "fuente a borrar invalida";
  return LocationResult::InvalidInput;
}

void locationFillState(JsonObject root, const String &clientId) {
  const uint32_t now = millis();
  prunePhones(now);
  pruneNodes(now);
  expireRequest(now);

  JsonObject location = root["location"].to<JsonObject>();
  location["selected"] = g_selected;
  location["selected_label"] = sourceLabel(g_selected);

  const ResolvedLocation resolved = resolveSelected(now);
  if (resolved.valid) {
    location["active"] = resolved.fix.source;
    location["active_label"] = resolved.fix.label;
    location["fresh"] = !resolved.stale;
    location["stale"] = resolved.stale;
    location["age_s"] = ageSeconds(now, resolved.fix.at);

    JsonObject fix = location["fix"].to<JsonObject>();
    fix["lat"] = resolved.fix.lat;
    fix["lon"] = resolved.fix.lon;
    fix["accuracy"] = resolved.fix.accuracy;
    fix["source"] = resolved.fix.source;
    fix["label"] = resolved.fix.label;
    fix["age_s"] = ageSeconds(now, resolved.fix.at);
    fix["fresh"] = !resolved.stale;
    fix["stale"] = resolved.stale;
  } else {
    location["active"] = nullptr;
    location["active_label"] = nullptr;
    location["fresh"] = false;
    location["stale"] = false;
    location["age_s"] = 0;
    location["fix"] = nullptr;
  }

  JsonObject sources = root["sources"].to<JsonObject>();

  JsonObject hub = sources["hub_gps"].to<JsonObject>();
  hub["available"] = false;
  hub["has_fix"] = false;

  JsonObject node = sources["node_gps"].to<JsonObject>();
  NodeEntry *latest = latestNode();
  if (latest != nullptr) {
    const bool seen =
        (uint32_t)(now - latest->lastSeenAt) < LM_NODE_SEEN_MS;
    const bool stale = latest->fix.valid && isStale(now, latest->fix.at);
    node["available"] = seen;
    node["id"] = latest->id;
    node["label"] = latest->fix.label.length() > 0
                        ? latest->fix.label
                        : String("Nodo ") + latest->id;
    node["last_seen_s"] = ageSeconds(now, latest->lastSeenAt);
    node["has_fix"] = latest->fix.valid;
    node["fresh"] = latest->fix.valid && !stale;
    node["stale"] = stale;
    node["age_s"] = latest->fix.valid ? ageSeconds(now, latest->fix.at) : 0;
    node["satellites"] = latest->satellites;
    node["gps_source"] = radioGpsSourceName(latest->gpsSource);
    node["rssi"] = latest->rssi;
    node["uptime_s"] = latest->uptimeS;
    node["selected"] = g_selected == String("node:") + latest->id;
  } else {
    node["available"] = false;
    node["has_fix"] = false;
  }

  JsonObject manual = sources["manual"].to<JsonObject>();
  manual["available"] = true;
  manual["has_fix"] = g_manual.valid;
  manual["fresh"] = g_manual.valid && !isStale(now, g_manual.at);
  manual["stale"] = g_manual.valid && isStale(now, g_manual.at);
  manual["age_s"] = g_manual.valid ? ageSeconds(now, g_manual.at) : 0;
  manual["selected"] = g_selected == "manual";

  JsonArray phones = sources["phones"].to<JsonArray>();
  for (size_t i = 0; i < LM_PHONE_MAX; i++) {
    PhoneEntry &phone = g_phones[i];
    if (!phone.used) {
      continue;
    }
    const bool stale = phone.fix.valid && isStale(now, phone.fix.at);
    JsonObject item = phones.add<JsonObject>();
    item["id"] = phone.id;
    item["label"] = phone.label;
    item["last_seen_s"] = ageSeconds(now, phone.lastSeenAt);
    item["has_fix"] = phone.fix.valid;
    item["fresh"] = phone.fix.valid && !stale;
    item["stale"] = stale;
    item["age_s"] = phone.fix.valid ? ageSeconds(now, phone.fix.at) : 0;
    item["selected"] =
        g_selected == String("phone:") + phone.id;
    item["self"] = clientId.length() > 0 && clientId == phone.id;
  }

  JsonArray nodes = sources["nodes"].to<JsonArray>();
  for (size_t i = 0; i < LM_NODE_MAX; i++) {
    NodeEntry &entry = g_nodes[i];
    if (!entry.used) {
      continue;
    }
    const bool stale = entry.fix.valid && isStale(now, entry.fix.at);
    JsonObject item = nodes.add<JsonObject>();
    item["id"] = entry.id;
    item["label"] = entry.fix.label.length() > 0
                        ? entry.fix.label
                        : String("Nodo ") + entry.id;
    item["last_seen_s"] = ageSeconds(now, entry.lastSeenAt);
    item["has_fix"] = entry.fix.valid;
    item["fresh"] = entry.fix.valid && !stale;
    item["stale"] = stale;
    item["age_s"] = entry.fix.valid ? ageSeconds(now, entry.fix.at) : 0;
    item["selected"] = g_selected == String("node:") + entry.id;
    item["satellites"] = entry.satellites;
    item["gps_source"] = radioGpsSourceName(entry.gpsSource);
    item["rssi"] = entry.rssi;
    item["uptime_s"] = entry.uptimeS;
    if (entry.fix.valid) {
      item["lat"] = entry.fix.lat;
      item["lon"] = entry.fix.lon;
      item["accuracy"] = entry.fix.accuracy;
    }
  }

  if (g_request.active) {
    JsonObject request = root["request"].to<JsonObject>();
    request["id"] = g_request.id;
    request["target"] = g_request.target;
    request["target_label"] = sourceLabel(g_request.target);
    request["requested_by"] = g_request.requestedBy;
    request["expires_in"] =
        (LM_LOCATION_REQUEST_MS - (now - g_request.startedAt) + 999) / 1000;
    request["for_me"] =
        clientId.length() > 0 &&
        (g_request.target == "auto" ||
         g_request.target == String("phone:") + clientId);
  } else {
    root["request"] = nullptr;
  }
}
