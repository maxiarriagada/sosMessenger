#include "radio_link.h"

#include <WiFi.h>
#include <esp_now.h>
#include <esp_wifi.h>
#include <math.h>
#include <string.h>

#if ROLE_HUB

#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>

#include "app_lock.h"
#include "location.h"

namespace {

const uint8_t kBroadcastAddress[6] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};

struct HubRxPacket {
  uint8_t kind;
  int8_t rssi;
  union {
    RadioNodeMessage node;
    RadioTextMessage text;
    RadioTextAck ack;
  } data;
};

struct SeenEntry {
  bool used;
  uint8_t kind;
  char from[LM_NODE_ID_MAX + 1];
  uint16_t bootId;
  uint32_t msgId;
  uint32_t at;
};

QueueHandle_t g_rxQueue = nullptr;
bool g_radioReady = false;
uint32_t g_lastSnapshotAt = 0;
uint32_t g_lastSnapshotLogAt = 0;
uint8_t g_lastSnapshotCount = 0xFF;
SeenEntry g_seen[LM_TEXT_DEDUPE];

bool alreadySeen(uint8_t kind, const char *from, uint16_t bootId,
                 uint32_t msgId, uint32_t now) {
  SeenEntry *oldest = &g_seen[0];
  for (size_t i = 0; i < LM_TEXT_DEDUPE; i++) {
    SeenEntry &entry = g_seen[i];
    if (entry.used && entry.kind == kind && entry.bootId == bootId &&
        entry.msgId == msgId && strcmp(entry.from, from) == 0) {
      if ((uint32_t)(now - entry.at) < LM_TEXT_DEDUPE_MS) {
        return true;
      }
      entry.at = now;
      return false;
    }
    if (!entry.used) {
      oldest = &entry;
      break;
    }
    if ((int32_t)(entry.at - oldest->at) < 0) {
      oldest = &entry;
    }
  }

  memset(oldest, 0, sizeof(*oldest));
  oldest->used = true;
  oldest->kind = kind;
  strncpy(oldest->from, from, sizeof(oldest->from) - 1);
  oldest->bootId = bootId;
  oldest->msgId = msgId;
  oldest->at = now;
  return false;
}

void onHubPacket(const esp_now_recv_info_t *info, const uint8_t *data, int len) {
  if (g_rxQueue == nullptr || len < 4) {
    return;
  }

  uint16_t magic = 0;
  uint8_t version = 0;
  uint8_t type = 0;
  memcpy(&magic, data, sizeof(magic));
  memcpy(&version, data + 2, sizeof(version));
  memcpy(&type, data + 3, sizeof(type));
  if (magic != LM_RADIO_MAGIC || version != LM_RADIO_VERSION) {
    return;
  }

  HubRxPacket packet;
  memset(&packet, 0, sizeof(packet));
  packet.rssi = (info != nullptr && info->rx_ctrl != nullptr)
                    ? info->rx_ctrl->rssi
                    : 0;

  if (type == LM_RADIO_TYPE_TEXT) {
    if (len < (int)sizeof(RadioTextMessage)) {
      return;
    }
    memcpy(&packet.data.text, data, sizeof(packet.data.text));
    packet.data.text.from[LM_NODE_ID_MAX] = '\0';
    packet.data.text.to[LM_NODE_ID_MAX] = '\0';
    if (!radioTextMessageValid(packet.data.text)) {
      return;
    }
    packet.kind = LM_RADIO_TYPE_TEXT;
  } else if (type == LM_RADIO_TYPE_TEXT_ACK) {
    if (len < (int)sizeof(RadioTextAck)) {
      return;
    }
    memcpy(&packet.data.ack, data, sizeof(packet.data.ack));
    packet.data.ack.from[LM_NODE_ID_MAX] = '\0';
    packet.data.ack.to[LM_NODE_ID_MAX] = '\0';
    if (!radioTextAckValid(packet.data.ack)) {
      return;
    }
    packet.kind = LM_RADIO_TYPE_TEXT_ACK;
  } else if (type == LM_RADIO_TYPE_NODE_STATUS) {
    if (len < (int)sizeof(RadioNodeMessage)) {
      return;
    }
    memcpy(&packet.data.node, data, sizeof(packet.data.node));
    packet.data.node.id[LM_NODE_ID_MAX] = '\0';
    if (!radioNodeMessageValid(packet.data.node)) {
      return;
    }
    packet.kind = LM_RADIO_TYPE_NODE_STATUS;
  } else {
    return;
  }

  xQueueSend(g_rxQueue, &packet, 0);
}

void relayText(RadioTextMessage &msg, uint32_t now) {
  if (msg.ttl <= 1) {
    return;
  }
  if (alreadySeen(LM_RADIO_TYPE_TEXT, msg.from, msg.fromBootId, msg.msgId,
                  now)) {
    return;
  }

  msg.ttl--;
  const esp_err_t err = esp_now_send(
      kBroadcastAddress, reinterpret_cast<const uint8_t *>(&msg), sizeof(msg));
  Serial.printf("[text] relay from=%s to=%s id=%lu len=%u ttl=%u%s\n",
                msg.from, msg.to, (unsigned long)msg.msgId,
                (unsigned)msg.textLen, (unsigned)msg.ttl,
                err == ESP_OK ? "" : " send_failed");
  if (err != ESP_OK) {
    Serial.printf("[text] relay error: %d\n", (int)err);
  }
}

void relayAck(RadioTextAck &ack, uint32_t now) {
  if (alreadySeen(LM_RADIO_TYPE_TEXT_ACK, ack.from, ack.fromBootId, ack.msgId,
                  now)) {
    return;
  }

  const esp_err_t err = esp_now_send(
      kBroadcastAddress, reinterpret_cast<const uint8_t *>(&ack), sizeof(ack));
  Serial.printf("[text] ack relay from=%s to=%s id=%lu status=%u%s\n", ack.from,
                ack.to, (unsigned long)ack.msgId, (unsigned)ack.status,
                err == ESP_OK ? "" : " send_failed");
  if (err != ESP_OK) {
    Serial.printf("[text] ack relay error: %d\n", (int)err);
  }
}

void sendSnapshot() {
  RadioPeerSnapshot snapshot;
  memset(&snapshot, 0, sizeof(snapshot));
  locationFillRadioSnapshot(snapshot);

  const esp_err_t err = esp_now_send(
      kBroadcastAddress, reinterpret_cast<const uint8_t *>(&snapshot),
      sizeof(snapshot));
  if (err != ESP_OK) {
    Serial.printf("[radio] snapshot send failed: %d\n", (int)err);
  }

  const uint32_t now = millis();
  if (snapshot.count != g_lastSnapshotCount ||
      (uint32_t)(now - g_lastSnapshotLogAt) >= LM_RADIO_PEER_LOG_MS) {
    g_lastSnapshotCount = snapshot.count;
    g_lastSnapshotLogAt = now;
    Serial.printf("[radio] snapshot tx nodes=%u\n", (unsigned)snapshot.count);
  }
}

} // namespace

void radioBegin() {
  g_rxQueue = xQueueCreate(LM_RADIO_RX_QUEUE, sizeof(HubRxPacket));
  if (g_rxQueue == nullptr) {
    Serial.println("[radio] RX queue allocation failed");
    return;
  }

  const esp_err_t channelErr =
      esp_wifi_set_channel(LM_AP_CHANNEL, WIFI_SECOND_CHAN_NONE);
  if (channelErr != ESP_OK) {
    Serial.printf("[radio] channel set failed: %d\n", (int)channelErr);
  }

  const esp_err_t initErr = esp_now_init();
  if (initErr != ESP_OK) {
    Serial.printf("[radio] esp_now_init failed: %d\n", (int)initErr);
    return;
  }

  const esp_err_t callbackErr = esp_now_register_recv_cb(onHubPacket);
  if (callbackErr != ESP_OK) {
    Serial.printf("[radio] recv callback failed: %d\n", (int)callbackErr);
    return;
  }

  esp_now_peer_info_t peer;
  memset(&peer, 0, sizeof(peer));
  memcpy(peer.peer_addr, kBroadcastAddress, sizeof(kBroadcastAddress));
  peer.channel = LM_AP_CHANNEL;
  peer.ifidx = WIFI_IF_AP;
  peer.encrypt = false;

  const esp_err_t peerErr = esp_now_add_peer(&peer);
  if (peerErr != ESP_OK) {
    Serial.printf("[radio] add broadcast peer failed: %d\n", (int)peerErr);
    return;
  }

  const uint32_t now = millis();
  g_lastSnapshotAt = now;
  g_lastSnapshotLogAt = now - LM_RADIO_PEER_LOG_MS;
  g_radioReady = true;
  Serial.printf("[radio] hub listening on channel %d\n", LM_AP_CHANNEL);
}

void radioLoop() {
  if (!g_radioReady || g_rxQueue == nullptr) {
    return;
  }

  HubRxPacket packet;
  const uint32_t now = millis();
  while (xQueueReceive(g_rxQueue, &packet, 0) == pdTRUE) {
    if (packet.kind == LM_RADIO_TYPE_TEXT) {
      relayText(packet.data.text, now);
      continue;
    }
    if (packet.kind == LM_RADIO_TYPE_TEXT_ACK) {
      relayAck(packet.data.ack, now);
      continue;
    }

    const RadioNodeMessage &msg = packet.data.node;
    String id(msg.id);
    id.trim();
    Serial.printf("[radio] rx node=%s fix=%u sat=%u rssi=%d src=%s\n",
                  id.c_str(), (unsigned)msg.hasFix,
                  (unsigned)msg.satellites, (int)packet.rssi,
                  radioGpsSourceName(msg.gpsSource));

    AppLock lock(100);
    if (!lock.locked()) {
      Serial.println("[radio] location busy, node message dropped");
      continue;
    }

    String message;
    const LocationResult result = locationUpdateNode(
        id, msg.hasFix != 0, msg.lat, msg.lon, msg.accuracy, msg.satellites,
        msg.gpsSource, msg.uptimeS, msg.seq, msg.bootId, msg.fixAgeMs,
        packet.rssi, message);
    if (result != LocationResult::Ok) {
      Serial.printf("[radio] node %s rejected: %s\n", id.c_str(),
                    message.c_str());
    }
  }
  if ((uint32_t)(now - g_lastSnapshotAt) >= LM_RADIO_SNAPSHOT_INTERVAL_MS) {
    g_lastSnapshotAt = now;
    sendSnapshot();
  }
}

#elif ROLE_NODE

#include <TinyGPSPlus.h>
#include <esp_system.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>

namespace {

const uint8_t kBroadcastAddress[6] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};

struct NodeRxPacket {
  uint8_t kind;
  int8_t rssi;
  union {
    RadioNodeMessage node;
    RadioPeerSnapshot snapshot;
    RadioTextMessage text;
    RadioTextAck ack;
  } data;
};

struct SeenEntry {
  bool used;
  uint8_t kind;
  char from[LM_NODE_ID_MAX + 1];
  uint16_t bootId;
  uint32_t msgId;
  uint32_t at;
};

struct PeerEntry {
  bool used = false;
  bool viaHub = false;
  String id;
  bool hasFix = false;
  uint8_t satellites = 0;
  uint8_t gpsSource = LM_RADIO_GPS_UNKNOWN;
  float lat = 0;
  float lon = 0;
  float accuracy = 0;
  int32_t altitudeM = 0;
  uint32_t uptimeS = 0;
  uint32_t seq = 0;
  uint16_t bootId = 0;
  uint16_t fixAgeMs = 0;
  int8_t rssi = 0;
  uint32_t updatedAt = 0;
  uint32_t lastSeenAt = 0;
};

struct PhoneFix {
  bool valid = false;
  float lat = 0;
  float lon = 0;
  float accuracy = 0;
  int32_t altitudeM = 0;
  uint16_t fixAgeMs = 0;
  uint8_t satellites = 0;
  uint32_t seq = 0;
  uint32_t receivedAt = 0;
};

struct EffectiveFix {
  bool valid = false;
  uint8_t source = LM_RADIO_GPS_UNKNOWN;
  float lat = 0;
  float lon = 0;
  float accuracy = 0;
  int32_t altitudeM = 0;
  uint16_t fixAgeMs = 0;
  uint8_t satellites = 0;
};

TinyGPSPlus g_gps;
PhoneFix g_phoneFix;
char g_nodeId[LM_NODE_ID_MAX + 1] = {0};
uint16_t g_bootId = 0;
uint32_t g_sequence = 0;
uint32_t g_lastFixSentAt = 0;
uint32_t g_lastHeartbeatAt = 0;
uint32_t g_lastPeerLogAt = 0;
uint32_t g_lastSnapshotAt = 0;
bool g_snapshotSeen = false;
bool g_radioReady = false;
QueueHandle_t g_rxQueue = nullptr;
QueueHandle_t g_textQueue = nullptr;
QueueHandle_t g_textAckQueue = nullptr;
PeerEntry g_peers[LM_NODE_MAX];
SeenEntry g_seen[LM_TEXT_DEDUPE];
uint32_t g_lastTextAt = 0;

void buildNodeId() {
  snprintf(g_nodeId, sizeof(g_nodeId), "%04X",
           (uint16_t)(ESP.getEfuseMac() & 0xFFFF));
}

bool gpsHasFix() {
  return g_gps.location.isValid() &&
         g_gps.location.age() < LM_GPS_FIX_MAX_AGE_MS;
}

float gpsAccuracy() {
  if (!g_gps.hdop.isValid()) {
    return 0;
  }
  return (float)g_gps.hdop.hdop() * 5.0f;
}

uint16_t clampFixAge(uint32_t ageMs) {
  return ageMs > 65535UL ? 65535U : (uint16_t)ageMs;
}

EffectiveFix currentFix(uint32_t now) {
  EffectiveFix fix;
  if (gpsHasFix()) {
    fix.valid = true;
    fix.source = LM_RADIO_GPS_SERIAL;
    fix.lat = (float)g_gps.location.lat();
    fix.lon = (float)g_gps.location.lng();
    fix.accuracy = gpsAccuracy();
    fix.altitudeM = g_gps.altitude.isValid()
                        ? (int32_t)lround(g_gps.altitude.meters())
                        : 0;
    const uint32_t sats = g_gps.satellites.value();
    fix.satellites = sats > 255 ? 255 : (uint8_t)sats;
    fix.fixAgeMs = clampFixAge(g_gps.location.age());
    return fix;
  }

  if (g_phoneFix.valid &&
      (uint32_t)(now - g_phoneFix.receivedAt) <= LM_PHONE_FIX_MAX_AGE_MS) {
    fix.valid = true;
    fix.source = LM_RADIO_GPS_PHONE;
    fix.lat = g_phoneFix.lat;
    fix.lon = g_phoneFix.lon;
    fix.accuracy = g_phoneFix.accuracy;
    fix.altitudeM = g_phoneFix.altitudeM;
    fix.satellites = g_phoneFix.satellites;
    fix.fixAgeMs = clampFixAge((uint32_t)g_phoneFix.fixAgeMs +
                               (uint32_t)(now - g_phoneFix.receivedAt));
  }
  return fix;
}

void fillNodeMessage(RadioNodeMessage &msg, uint32_t seq,
                     const EffectiveFix &fix) {
  memset(&msg, 0, sizeof(msg));
  msg.magic = LM_RADIO_MAGIC;
  msg.version = LM_RADIO_VERSION;
  msg.type = LM_RADIO_TYPE_NODE_STATUS;
  strncpy(msg.id, g_nodeId, sizeof(msg.id) - 1);
  msg.hasFix = fix.valid ? 1 : 0;
  msg.gpsSource = fix.source;
  msg.bootId = g_bootId;
  msg.uptimeS = millis() / 1000UL;
  msg.seq = seq;
  if (fix.valid) {
    msg.lat = fix.lat;
    msg.lon = fix.lon;
    msg.accuracy = fix.accuracy;
    msg.altitudeM = fix.altitudeM;
    msg.satellites = fix.satellites;
    msg.fixAgeMs = fix.fixAgeMs;
  }
}

bool alreadySeen(uint8_t kind, const char *from, uint16_t bootId,
                 uint32_t msgId, uint32_t now) {
  SeenEntry *oldest = &g_seen[0];
  for (size_t i = 0; i < LM_TEXT_DEDUPE; i++) {
    SeenEntry &entry = g_seen[i];
    if (entry.used && entry.kind == kind && entry.bootId == bootId &&
        entry.msgId == msgId && strcmp(entry.from, from) == 0) {
      if ((uint32_t)(now - entry.at) < LM_TEXT_DEDUPE_MS) {
        return true;
      }
      entry.at = now;
      return false;
    }
    if (!entry.used) {
      oldest = &entry;
      break;
    }
    if ((int32_t)(entry.at - oldest->at) < 0) {
      oldest = &entry;
    }
  }

  memset(oldest, 0, sizeof(*oldest));
  oldest->used = true;
  oldest->kind = kind;
  strncpy(oldest->from, from, sizeof(oldest->from) - 1);
  oldest->bootId = bootId;
  oldest->msgId = msgId;
  oldest->at = now;
  return false;
}

void pruneSeen(uint32_t now) {
  for (size_t i = 0; i < LM_TEXT_DEDUPE; i++) {
    if (g_seen[i].used &&
        (uint32_t)(now - g_seen[i].at) >= LM_TEXT_DEDUPE_MS) {
      g_seen[i].used = false;
    }
  }
}

void sendTextAck(const RadioTextMessage &msg, uint8_t status) {
  RadioTextAck ack;
  memset(&ack, 0, sizeof(ack));
  ack.magic = LM_RADIO_MAGIC;
  ack.version = LM_RADIO_VERSION;
  ack.type = LM_RADIO_TYPE_TEXT_ACK;
  ack.msgId = msg.msgId;
  strncpy(ack.from, g_nodeId, sizeof(ack.from) - 1);
  strncpy(ack.to, msg.from, sizeof(ack.to) - 1);
  ack.fromBootId = g_bootId;
  ack.status = status;

  const esp_err_t err = esp_now_send(
      kBroadcastAddress, reinterpret_cast<const uint8_t *>(&ack), sizeof(ack));
  Serial.printf("[text] ack tx to=%s id=%lu status=%u%s\n", ack.to,
                (unsigned long)ack.msgId, (unsigned)ack.status,
                err == ESP_OK ? "" : " send_failed");
  if (err != ESP_OK) {
    Serial.printf("[text] ack tx error: %d\n", (int)err);
  }
}

void handleIncomingText(const RadioTextMessage &msg, uint32_t now) {
  const bool broadcast = (msg.flags & LM_RADIO_TEXT_FLAG_BROADCAST) != 0 ||
                         strcmp(msg.to, LM_RADIO_TEXT_BROADCAST_ID) == 0;
  if (strcmp(msg.from, g_nodeId) == 0) {
    return;
  }
  if (!broadcast && strcmp(msg.to, g_nodeId) != 0) {
    return;
  }

  if (alreadySeen(LM_RADIO_TYPE_TEXT, msg.from, msg.fromBootId, msg.msgId,
                  now)) {
    if (!broadcast) {
      sendTextAck(msg, LM_RADIO_TEXT_ACK_RECEIVED);
    }
    return;
  }

  const bool queued =
      g_textQueue != nullptr &&
      xQueueSend(g_textQueue, &msg, 0) == pdTRUE;
  if (!queued) {
    Serial.println("[text] BLE text queue full");
  }
  if (!broadcast) {
    sendTextAck(msg, queued ? LM_RADIO_TEXT_ACK_RECEIVED
                            : LM_RADIO_TEXT_ACK_ERROR);
  }

  Serial.printf("[text] rx from=%s to=%s id=%lu len=%u%s\n", msg.from, msg.to,
                (unsigned long)msg.msgId, (unsigned)msg.textLen,
                broadcast ? " broadcast" : "");
}

void handleIncomingAck(const RadioTextAck &ack, uint32_t now) {
  if (strcmp(ack.to, g_nodeId) != 0) {
    return;
  }
  if (alreadySeen(LM_RADIO_TYPE_TEXT_ACK, ack.from, ack.fromBootId, ack.msgId,
                  now)) {
    return;
  }

  const bool queued =
      g_textAckQueue != nullptr &&
      xQueueSend(g_textAckQueue, &ack, 0) == pdTRUE;
  if (!queued) {
    Serial.println("[text] BLE ack queue full");
  }
  Serial.printf("[text] ack rx from=%s id=%lu status=%u\n", ack.from,
                (unsigned long)ack.msgId, (unsigned)ack.status);
}

uint32_t effectiveAgeMs(const PeerEntry &peer, uint32_t now) {
  return (uint32_t)peer.fixAgeMs + (uint32_t)(now - peer.updatedAt);
}

PeerEntry *findPeer(const String &id) {
  for (size_t i = 0; i < LM_NODE_MAX; i++) {
    if (g_peers[i].used && g_peers[i].id == id) {
      return &g_peers[i];
    }
  }
  return nullptr;
}

void clearPeer(PeerEntry &peer) {
  peer.used = false;
  peer.viaHub = false;
  peer.id = String();
  peer.hasFix = false;
  peer.satellites = 0;
  peer.gpsSource = LM_RADIO_GPS_UNKNOWN;
  peer.lat = 0;
  peer.lon = 0;
  peer.accuracy = 0;
  peer.altitudeM = 0;
  peer.uptimeS = 0;
  peer.seq = 0;
  peer.bootId = 0;
  peer.fixAgeMs = 0;
  peer.rssi = 0;
  peer.updatedAt = 0;
  peer.lastSeenAt = 0;
}

PeerEntry *allocatePeer() {
  for (size_t i = 0; i < LM_NODE_MAX; i++) {
    if (!g_peers[i].used) {
      clearPeer(g_peers[i]);
      g_peers[i].used = true;
      return &g_peers[i];
    }
  }

  PeerEntry *oldest = &g_peers[0];
  for (size_t i = 1; i < LM_NODE_MAX; i++) {
    if ((int32_t)(g_peers[i].lastSeenAt - oldest->lastSeenAt) < 0) {
      oldest = &g_peers[i];
    }
  }
  clearPeer(*oldest);
  oldest->used = true;
  return oldest;
}

void logPeer(const PeerEntry &peer, uint32_t now, const char *marker) {
  Serial.printf(
      "[peer] %s id=%s route=%s fix=%u src=%s age=%lums seen=%lums seq=%lu "
      "rssi=%d\n",
      marker, peer.id.c_str(), peer.viaHub ? "hub" : "direct",
      (unsigned)peer.hasFix, radioGpsSourceName(peer.gpsSource),
      (unsigned long)effectiveAgeMs(peer, now),
      (unsigned long)(uint32_t)(now - peer.lastSeenAt),
      (unsigned long)peer.seq, (int)peer.rssi);
}

void mergePeer(const PeerEntry &candidate, uint32_t now) {
  PeerEntry *existing = findPeer(candidate.id);
  if (existing == nullptr) {
    existing = allocatePeer();
    *existing = candidate;
    logPeer(*existing, now, "new");
    return;
  }

  const uint32_t candidateAge = effectiveAgeMs(candidate, now);
  const uint32_t currentAge = effectiveAgeMs(*existing, now);
  const bool sameBoot = existing->bootId == candidate.bootId;
  const bool newerSeq =
      sameBoot && (int32_t)(candidate.seq - existing->seq) > 0;
  const bool reboot =
      !sameBoot && (candidate.hasFix || !existing->hasFix) &&
      (candidateAge + 3000UL < currentAge);
  const bool gainFix =
      candidate.hasFix && !existing->hasFix &&
      candidateAge <= currentAge + 10000UL;

  if (newerSeq || reboot || gainFix) {
    *existing = candidate;
    logPeer(*existing, now, "upd");
    return;
  }

  if (candidate.hasFix == existing->hasFix) {
    existing->lastSeenAt = now;
    if (!candidate.viaHub) {
      existing->viaHub = false;
      existing->rssi = candidate.rssi;
    } else if (existing->viaHub) {
      existing->rssi = candidate.rssi;
    }
  }
}

void updatePeerFromNodeMessage(const RadioNodeMessage &msg, int8_t rssi,
                               uint32_t now) {
  if (strcmp(msg.id, g_nodeId) == 0) {
    return;
  }

  PeerEntry candidate;
  memset(&candidate, 0, sizeof(candidate));
  candidate.used = true;
  candidate.viaHub = false;
  candidate.id = msg.id;
  candidate.hasFix = msg.hasFix != 0;
  candidate.satellites = msg.satellites;
  candidate.gpsSource = msg.gpsSource;
  candidate.lat = msg.lat;
  candidate.lon = msg.lon;
  candidate.accuracy = msg.accuracy;
  candidate.altitudeM = msg.altitudeM;
  candidate.uptimeS = msg.uptimeS;
  candidate.seq = msg.seq;
  candidate.bootId = msg.bootId;
  candidate.fixAgeMs = msg.fixAgeMs;
  candidate.rssi = rssi;
  candidate.updatedAt = now;
  candidate.lastSeenAt = now;
  mergePeer(candidate, now);
}

void updatePeerFromSnapshot(const RadioPeerSnapshot &snapshot, uint32_t now) {
  const uint8_t count =
      snapshot.count > LM_NODE_MAX ? LM_NODE_MAX : snapshot.count;
  for (uint8_t i = 0; i < count; i++) {
    RadioPeerEntry peer = snapshot.peers[i];
    peer.id[LM_NODE_ID_MAX] = '\0';
    if (!radioIdValid(peer.id, LM_NODE_ID_MAX)) {
      continue;
    }
    if (strcmp(peer.id, g_nodeId) == 0) {
      continue;
    }

    PeerEntry candidate;
    memset(&candidate, 0, sizeof(candidate));
    candidate.used = true;
    candidate.viaHub = true;
    candidate.id = peer.id;
    candidate.hasFix = peer.hasFix != 0;
    candidate.satellites = peer.satellites;
    candidate.gpsSource = peer.gpsSource;
    candidate.lat = peer.lat;
    candidate.lon = peer.lon;
    candidate.accuracy = peer.accuracy;
    candidate.altitudeM = peer.altitudeM;
    candidate.uptimeS = peer.uptimeS;
    candidate.seq = peer.seq;
    candidate.bootId = peer.bootId;
    candidate.fixAgeMs = peer.fixAgeMs;
    candidate.rssi = peer.rssi;
    candidate.updatedAt = now;
    candidate.lastSeenAt = now;
    mergePeer(candidate, now);
  }
}

void onRadioPacket(const esp_now_recv_info_t *info, const uint8_t *data,
                   int len) {
  if (g_rxQueue == nullptr || len < 4) {
    return;
  }

  uint16_t magic = 0;
  uint8_t version = 0;
  uint8_t type = 0;
  memcpy(&magic, data, sizeof(magic));
  memcpy(&version, data + 2, sizeof(version));
  memcpy(&type, data + 3, sizeof(type));
  if (magic != LM_RADIO_MAGIC || version != LM_RADIO_VERSION) {
    return;
  }

  NodeRxPacket packet;
  memset(&packet, 0, sizeof(packet));
  packet.rssi = (info != nullptr && info->rx_ctrl != nullptr)
                    ? info->rx_ctrl->rssi
                    : 0;

  if (type == LM_RADIO_TYPE_TEXT) {
    if (len < (int)sizeof(RadioTextMessage)) {
      return;
    }
    memcpy(&packet.data.text, data, sizeof(packet.data.text));
    packet.data.text.from[LM_NODE_ID_MAX] = '\0';
    packet.data.text.to[LM_NODE_ID_MAX] = '\0';
    if (!radioTextMessageValid(packet.data.text)) {
      return;
    }
    packet.kind = LM_RADIO_TYPE_TEXT;
  } else if (type == LM_RADIO_TYPE_TEXT_ACK) {
    if (len < (int)sizeof(RadioTextAck)) {
      return;
    }
    memcpy(&packet.data.ack, data, sizeof(packet.data.ack));
    packet.data.ack.from[LM_NODE_ID_MAX] = '\0';
    packet.data.ack.to[LM_NODE_ID_MAX] = '\0';
    if (!radioTextAckValid(packet.data.ack)) {
      return;
    }
    packet.kind = LM_RADIO_TYPE_TEXT_ACK;
  } else if (type == LM_RADIO_TYPE_PEER_SNAPSHOT) {
    if (len < (int)sizeof(RadioPeerSnapshot)) {
      return;
    }
    memcpy(&packet.data.snapshot, data, sizeof(packet.data.snapshot));
    packet.data.snapshot.count =
        packet.data.snapshot.count > LM_NODE_MAX
            ? LM_NODE_MAX
            : packet.data.snapshot.count;
    if (!radioPeerSnapshotValid(packet.data.snapshot)) {
      return;
    }
    packet.kind = LM_RADIO_TYPE_PEER_SNAPSHOT;
  } else if (type == LM_RADIO_TYPE_NODE_STATUS) {
    if (len < (int)sizeof(RadioNodeMessage)) {
      return;
    }
    memcpy(&packet.data.node, data, sizeof(packet.data.node));
    packet.data.node.id[LM_NODE_ID_MAX] = '\0';
    if (!radioNodeMessageValid(packet.data.node)) {
      return;
    }
    packet.kind = LM_RADIO_TYPE_NODE_STATUS;
  } else {
    return;
  }

  xQueueSend(g_rxQueue, &packet, 0);
}

void processRxQueue(uint32_t now) {
  NodeRxPacket packet;
  while (xQueueReceive(g_rxQueue, &packet, 0) == pdTRUE) {
    if (packet.kind == LM_RADIO_TYPE_TEXT) {
      handleIncomingText(packet.data.text, now);
    } else if (packet.kind == LM_RADIO_TYPE_TEXT_ACK) {
      handleIncomingAck(packet.data.ack, now);
    } else if (packet.kind == LM_RADIO_TYPE_PEER_SNAPSHOT) {
      g_lastSnapshotAt = now;
      g_snapshotSeen = true;
      updatePeerFromSnapshot(packet.data.snapshot, now);
    } else if (packet.kind == LM_RADIO_TYPE_NODE_STATUS) {
      updatePeerFromNodeMessage(packet.data.node, packet.rssi, now);
    }
  }
}

void prunePeers(uint32_t now) {
  for (size_t i = 0; i < LM_NODE_MAX; i++) {
    if (g_peers[i].used &&
        (uint32_t)(now - g_peers[i].lastSeenAt) >= LM_NODE_PRUNE_MS) {
      clearPeer(g_peers[i]);
    }
  }
}

void logPeers(uint32_t now) {
  if ((uint32_t)(now - g_lastPeerLogAt) < LM_RADIO_PEER_LOG_MS) {
    return;
  }
  g_lastPeerLogAt = now;

  bool any = false;
  for (size_t i = 0; i < LM_NODE_MAX; i++) {
    if (g_peers[i].used) {
      any = true;
      logPeer(g_peers[i], now, "sum");
    }
  }
  if (!any) {
    Serial.println("[peer] none");
  }
  if (g_snapshotSeen) {
    Serial.printf("[peer] hub_snapshot_age=%lums\n",
                  (unsigned long)(uint32_t)(now - g_lastSnapshotAt));
  } else {
    Serial.println("[peer] hub_snapshot=none");
  }
}

void sendNodeStatus(const EffectiveFix &fix) {
  g_sequence++;
  if (g_sequence == 0) {
    g_sequence = 1;
  }

  RadioNodeMessage msg;
  fillNodeMessage(msg, g_sequence, fix);

  const esp_err_t err = esp_now_send(kBroadcastAddress,
                                     reinterpret_cast<const uint8_t *>(&msg),
                                     sizeof(msg));
  if (err != ESP_OK) {
    Serial.printf("[radio] node send failed: %d\n", (int)err);
  }

  const uint32_t now = millis();
  if (fix.valid) {
    g_lastFixSentAt = now;
    Serial.printf(
        "[radio] tx fix id=%s boot=%u seq=%lu src=%s sat=%u lat=%.6f "
        "lon=%.6f\n",
        g_nodeId, (unsigned)g_bootId, (unsigned long)msg.seq,
        radioGpsSourceName(msg.gpsSource), (unsigned)msg.satellites, msg.lat,
        msg.lon);
  } else {
    g_lastHeartbeatAt = now;
    Serial.printf("[radio] tx heartbeat id=%s boot=%u seq=%lu\n", g_nodeId,
                  (unsigned)g_bootId, (unsigned long)msg.seq);
  }
}

} // namespace

const char *radioNodeId() { return g_nodeId; }

bool radioSetPhoneFix(double lat, double lon, float accuracy, int32_t altitudeM,
                      uint16_t fixAgeMs, uint8_t satellites, uint32_t seq) {
  if (!isfinite(lat) || !isfinite(lon) || lat < -90.0 || lat > 90.0 ||
      lon < -180.0 || lon > 180.0) {
    return false;
  }

  const bool wasValid = g_phoneFix.valid;
  const uint32_t now = millis();
  g_phoneFix.valid = true;
  g_phoneFix.lat = (float)lat;
  g_phoneFix.lon = (float)lon;
  g_phoneFix.accuracy =
      isfinite(accuracy) && accuracy > 0 ? accuracy : 0;
  g_phoneFix.altitudeM = altitudeM;
  g_phoneFix.fixAgeMs = fixAgeMs;
  g_phoneFix.satellites = satellites;
  g_phoneFix.seq = seq;
  g_phoneFix.receivedAt = now;
  if (!wasValid) {
    g_lastFixSentAt = now - LM_NODE_FIX_INTERVAL_MS;
  }

  Serial.printf(
      "[ble] phone fix seq=%lu lat=%.6f lon=%.6f acc=%.1f sat=%u age=%ums\n",
      (unsigned long)seq, lat, lon, (double)g_phoneFix.accuracy,
      (unsigned)satellites, (unsigned)fixAgeMs);
  return true;
}

void radioClearPhoneFix() {
  if (!g_phoneFix.valid) {
    return;
  }
  g_phoneFix.valid = false;
  Serial.println("[ble] phone fix cleared");
}

void radioFillNodeMessage(RadioNodeMessage &msg) {
  fillNodeMessage(msg, g_sequence, currentFix(millis()));
}

size_t radioCopyPeers(RadioPeerEntry *out, size_t maxCount) {
  if (out == nullptr || maxCount == 0) {
    return 0;
  }

  const uint32_t now = millis();
  size_t count = 0;
  for (size_t i = 0; i < LM_NODE_MAX && count < maxCount; i++) {
    if (!g_peers[i].used) {
      continue;
    }

    RadioPeerEntry &entry = out[count];
    memset(&entry, 0, sizeof(entry));
    strncpy(entry.id, g_peers[i].id.c_str(), sizeof(entry.id) - 1);
    entry.hasFix = g_peers[i].hasFix ? 1 : 0;
    entry.satellites = g_peers[i].satellites;
    entry.gpsSource = g_peers[i].gpsSource;
    entry.lat = g_peers[i].lat;
    entry.lon = g_peers[i].lon;
    entry.accuracy = g_peers[i].accuracy;
    entry.altitudeM = g_peers[i].altitudeM;
    entry.uptimeS = g_peers[i].uptimeS;
    entry.seq = g_peers[i].seq;
    entry.bootId = g_peers[i].bootId;
    entry.fixAgeMs = clampFixAge(effectiveAgeMs(g_peers[i], now));
    entry.ageS = clampFixAge((uint32_t)(now - g_peers[i].lastSeenAt) / 1000UL);
    entry.rssi = g_peers[i].rssi;
    count++;
  }
  return count;
}

bool radioSendText(const char *to, const char *text, size_t textLen,
                   uint32_t msgId, uint32_t sentAt, bool broadcast) {
  if (!g_radioReady || to == nullptr || text == nullptr || textLen == 0 ||
      textLen > LM_TEXT_MAX) {
    return false;
  }

  if (strcmp(to, LM_RADIO_TEXT_BROADCAST_ID) == 0) {
    if (!broadcast) {
      return false;
    }
  } else if (broadcast || !radioIdValid(to, LM_NODE_ID_MAX)) {
    return false;
  }

  const uint32_t now = millis();
  if (g_lastTextAt != 0 &&
      (uint32_t)(now - g_lastTextAt) < LM_TEXT_MIN_INTERVAL_MS) {
    return false;
  }

  RadioTextMessage msg;
  memset(&msg, 0, sizeof(msg));
  msg.magic = LM_RADIO_MAGIC;
  msg.version = LM_RADIO_VERSION;
  msg.type = LM_RADIO_TYPE_TEXT;
  msg.msgId = msgId;
  msg.sentAt = sentAt;
  strncpy(msg.from, g_nodeId, sizeof(msg.from) - 1);
  strncpy(msg.to, to, sizeof(msg.to) - 1);
  msg.fromBootId = g_bootId;
  msg.ttl = LM_TEXT_TTL;
  msg.flags = broadcast ? LM_RADIO_TEXT_FLAG_BROADCAST : 0;
  msg.textLen = (uint8_t)textLen;
  memcpy(msg.text, text, textLen);

  const esp_err_t err = esp_now_send(
      kBroadcastAddress, reinterpret_cast<const uint8_t *>(&msg), sizeof(msg));
  if (err != ESP_OK) {
    Serial.printf("[text] tx error: %d\n", (int)err);
    return false;
  }

  alreadySeen(LM_RADIO_TYPE_TEXT, msg.from, msg.fromBootId, msg.msgId, now);
  g_lastTextAt = now;
  Serial.printf("[text] tx to=%s id=%lu len=%u%s\n", msg.to,
                (unsigned long)msg.msgId, (unsigned)msg.textLen,
                broadcast ? " broadcast" : "");
  return true;
}

size_t radioCopyIncomingText(RadioTextMessage *out, size_t maxCount) {
  if (out == nullptr || maxCount == 0 || g_textQueue == nullptr) {
    return 0;
  }
  size_t count = 0;
  while (count < maxCount &&
         xQueueReceive(g_textQueue, &out[count], 0) == pdTRUE) {
    count++;
  }
  return count;
}

size_t radioCopyIncomingAck(RadioTextAck *out, size_t maxCount) {
  if (out == nullptr || maxCount == 0 || g_textAckQueue == nullptr) {
    return 0;
  }
  size_t count = 0;
  while (count < maxCount &&
         xQueueReceive(g_textAckQueue, &out[count], 0) == pdTRUE) {
    count++;
  }
  return count;
}

void radioBegin() {
  buildNodeId();
  g_bootId = (uint16_t)esp_random();
  if (g_bootId == 0) {
    g_bootId = 1;
  }

  g_rxQueue = xQueueCreate(LM_RADIO_RX_QUEUE, sizeof(NodeRxPacket));
  if (g_rxQueue == nullptr) {
    Serial.println("[radio] RX queue allocation failed");
  }
  g_textQueue = xQueueCreate(LM_TEXT_QUEUE, sizeof(RadioTextMessage));
  g_textAckQueue = xQueueCreate(LM_TEXT_QUEUE, sizeof(RadioTextAck));
  if (g_textQueue == nullptr || g_textAckQueue == nullptr) {
    Serial.println("[radio] text queue allocation failed");
  }

  Serial1.begin(LM_GPS_BAUD, SERIAL_8N1, LM_GPS_RX_PIN, LM_GPS_TX_PIN);

  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.disconnect();

  const esp_err_t channelErr =
      esp_wifi_set_channel(LM_AP_CHANNEL, WIFI_SECOND_CHAN_NONE);
  if (channelErr != ESP_OK) {
    Serial.printf("[radio] channel set failed: %d\n", (int)channelErr);
  }

  const esp_err_t initErr = esp_now_init();
  if (initErr != ESP_OK) {
    Serial.printf("[radio] esp_now_init failed: %d\n", (int)initErr);
    return;
  }

  esp_now_peer_info_t peer;
  memset(&peer, 0, sizeof(peer));
  memcpy(peer.peer_addr, kBroadcastAddress, sizeof(kBroadcastAddress));
  peer.channel = LM_AP_CHANNEL;
  peer.encrypt = false;

  const esp_err_t peerErr = esp_now_add_peer(&peer);
  if (peerErr != ESP_OK) {
    Serial.printf("[radio] add broadcast peer failed: %d\n", (int)peerErr);
    return;
  }

  const esp_err_t callbackErr = esp_now_register_recv_cb(onRadioPacket);
  if (callbackErr != ESP_OK) {
    Serial.printf("[radio] recv callback failed: %d\n", (int)callbackErr);
    return;
  }

  for (size_t i = 0; i < LM_NODE_MAX; i++) {
    clearPeer(g_peers[i]);
  }

  const uint32_t now = millis();
  g_lastFixSentAt = now - LM_NODE_FIX_INTERVAL_MS;
  g_lastHeartbeatAt = now - LM_NODE_HEARTBEAT_MS;
  g_lastPeerLogAt = now;
  g_radioReady = true;

  Serial.printf(
      "[radio] node id=%s boot=%u channel=%d gps(rx=%d tx=%d baud=%d)\n",
      g_nodeId, (unsigned)g_bootId, LM_AP_CHANNEL, LM_GPS_RX_PIN,
      LM_GPS_TX_PIN, LM_GPS_BAUD);
}

void radioLoop() {
  if (!g_radioReady) {
    return;
  }

  const uint32_t now = millis();
  processRxQueue(now);
  prunePeers(now);
  pruneSeen(now);
  logPeers(now);

  while (Serial1.available() > 0) {
    g_gps.encode((char)Serial1.read());
  }

  const EffectiveFix fix = currentFix(now);
  if (fix.valid) {
    if ((uint32_t)(now - g_lastFixSentAt) >= LM_NODE_FIX_INTERVAL_MS) {
      sendNodeStatus(fix);
    }
  } else if ((uint32_t)(now - g_lastHeartbeatAt) >= LM_NODE_HEARTBEAT_MS) {
    sendNodeStatus(fix);
  }
}

#else

void radioBegin() {}

void radioLoop() {}

#endif
