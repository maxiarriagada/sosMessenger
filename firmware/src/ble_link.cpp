#include "ble_link.h"

#include "config.h"

#if ROLE_NODE

#include <NimBLEDevice.h>

#include <math.h>
#include <string.h>

#include "ble_protocol.h"
#include "radio_link.h"

namespace {

NimBLEServer *g_server = nullptr;
NimBLECharacteristic *g_gpsRx = nullptr;
NimBLECharacteristic *g_peerTx = nullptr;
NimBLECharacteristic *g_status = nullptr;
NimBLECharacteristic *g_textRx = nullptr;
NimBLECharacteristic *g_textTx = nullptr;
bool g_bleReady = false;
volatile bool g_connected = false;
volatile bool g_peerSubscribed = false;
volatile bool g_statusSubscribed = false;
volatile bool g_textSubscribed = false;
uint32_t g_lastStatusAt = 0;
uint32_t g_lastPeerAt = 0;

void buildStatus(BleStatusPacket &status) {
  memset(&status, 0, sizeof(status));

  RadioNodeMessage node;
  radioFillNodeMessage(node);

  status.magic = LM_BLE_MAGIC;
  status.version = LM_BLE_VERSION;
  status.type = LM_BLE_TYPE_STATUS;
  strncpy(status.nodeId, node.id, sizeof(status.nodeId) - 1);
  status.hasFix = node.hasFix;
  status.gpsSource = node.gpsSource;
  status.satellites = node.satellites;
  status.lat = node.lat;
  status.lon = node.lon;
  status.accuracy = node.accuracy;
  status.altitudeM = node.altitudeM;
  status.fixAgeMs = node.fixAgeMs;
  status.bootId = node.bootId;
  status.uptimeS = node.uptimeS;
  status.seq = node.seq;

  RadioPeerEntry peers[LM_NODE_MAX];
  status.peerCount = (uint8_t)radioCopyPeers(peers, LM_NODE_MAX);
}

void buildPeerSnapshot(RadioPeerSnapshot &snapshot) {
  memset(&snapshot, 0, sizeof(snapshot));
  snapshot.magic = LM_RADIO_MAGIC;
  snapshot.version = LM_RADIO_VERSION;
  snapshot.type = LM_RADIO_TYPE_PEER_SNAPSHOT;
  snapshot.hubUptimeS = millis() / 1000UL;
  snapshot.count = (uint8_t)radioCopyPeers(snapshot.peers, LM_NODE_MAX);
}

void notifyText(const RadioTextMessage &msg) {
  if (g_textTx == nullptr || !g_textSubscribed) {
    return;
  }

  BleTextPacket packet;
  memset(&packet, 0, sizeof(packet));
  packet.magic = LM_BLE_MAGIC;
  packet.version = LM_BLE_VERSION;
  packet.type = LM_BLE_TYPE_TEXT;
  packet.msgId = msg.msgId;
  packet.sentAt = msg.sentAt;
  strncpy(packet.from, msg.from, sizeof(packet.from) - 1);
  strncpy(packet.to, msg.to, sizeof(packet.to) - 1);
  packet.fromBootId = msg.fromBootId;
  packet.flags = msg.flags & LM_BLE_TEXT_FLAG_BROADCAST;
  packet.textLen = msg.textLen;
  memcpy(packet.text, msg.text, msg.textLen);

  g_textTx->setValue(reinterpret_cast<const uint8_t *>(&packet),
                     sizeof(packet));
  g_textTx->notify();
}

void notifyTextAck(const char *to, uint32_t msgId, uint8_t status) {
  if (g_textTx == nullptr || !g_textSubscribed) {
    return;
  }

  RadioNodeMessage node;
  radioFillNodeMessage(node);

  BleTextAckPacket packet;
  memset(&packet, 0, sizeof(packet));
  packet.magic = LM_BLE_MAGIC;
  packet.version = LM_BLE_VERSION;
  packet.type = LM_BLE_TYPE_TEXT_ACK;
  packet.msgId = msgId;
  strncpy(packet.from, radioNodeId(), sizeof(packet.from) - 1);
  strncpy(packet.to, (to != nullptr && to[0] != '\0') ? to : radioNodeId(),
          sizeof(packet.to) - 1);
  packet.fromBootId = node.bootId;
  packet.status = status;

  g_textTx->setValue(reinterpret_cast<const uint8_t *>(&packet),
                     sizeof(packet));
  g_textTx->notify();
}

void notifyRadioAck(const RadioTextAck &ack) {
  if (g_textTx == nullptr || !g_textSubscribed) {
    return;
  }

  BleTextAckPacket packet;
  memset(&packet, 0, sizeof(packet));
  packet.magic = LM_BLE_MAGIC;
  packet.version = LM_BLE_VERSION;
  packet.type = LM_BLE_TYPE_TEXT_ACK;
  packet.msgId = ack.msgId;
  strncpy(packet.from, ack.from, sizeof(packet.from) - 1);
  strncpy(packet.to, ack.to, sizeof(packet.to) - 1);
  packet.fromBootId = ack.fromBootId;
  packet.status = ack.status;

  g_textTx->setValue(reinterpret_cast<const uint8_t *>(&packet),
                     sizeof(packet));
  g_textTx->notify();
}

void updateStatusValue() {
  if (g_status == nullptr) {
    return;
  }
  BleStatusPacket status;
  buildStatus(status);
  g_status->setValue(reinterpret_cast<const uint8_t *>(&status),
                     sizeof(status));
}

class ServerCallbacks : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer *, NimBLEConnInfo &connInfo) override {
    g_connected = true;
    g_lastStatusAt = millis() - LM_BLE_STATUS_INTERVAL_MS;
    g_lastPeerAt = millis() - LM_BLE_PEER_INTERVAL_MS;
    Serial.printf("[ble] central connected: %s\n",
                  connInfo.toString().c_str());
  }

  void onDisconnect(NimBLEServer *, NimBLEConnInfo &, int reason) override {
    g_connected = false;
    g_peerSubscribed = false;
    g_statusSubscribed = false;
    g_textSubscribed = false;
    Serial.printf("[ble] central disconnected reason=%d\n", reason);
    NimBLEDevice::startAdvertising();
  }
};

class GpsCallbacks : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic *characteristic,
               NimBLEConnInfo &) override {
    const NimBLEAttValue value = characteristic->getValue();
    if (value.length() < sizeof(BleGpsPacket)) {
      return;
    }

    BleGpsPacket packet;
    memcpy(&packet, value.data(), sizeof(packet));
    if (packet.magic != LM_BLE_MAGIC || packet.version != LM_BLE_VERSION ||
        packet.type != LM_BLE_TYPE_GPS) {
      return;
    }

    if ((packet.flags & LM_BLE_GPS_FLAG_VALID) == 0) {
      radioClearPhoneFix();
      return;
    }

    if (!radioSetPhoneFix(packet.lat, packet.lon, packet.accuracy,
                          packet.altitudeM, packet.fixAgeMs,
                          packet.satellites, packet.seq)) {
      Serial.printf("[ble] invalid phone fix seq=%lu\n",
                    (unsigned long)packet.seq);
      return;
    }

    g_lastStatusAt = millis() - LM_BLE_STATUS_INTERVAL_MS;
  }
};

class TextRxCallbacks : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic *characteristic,
               NimBLEConnInfo &) override {
    const NimBLEAttValue value = characteristic->getValue();
    if (value.length() < sizeof(BleTextPacket)) {
      return;
    }

    BleTextPacket packet;
    memcpy(&packet, value.data(), sizeof(packet));
    packet.from[LM_NODE_ID_MAX] = '\0';
    packet.to[LM_NODE_ID_MAX] = '\0';

    const bool broadcast =
        (packet.flags & LM_BLE_TEXT_FLAG_BROADCAST) != 0 ||
        strcmp(packet.to, LM_RADIO_TEXT_BROADCAST_ID) == 0;
    if (packet.magic != LM_BLE_MAGIC || packet.version != LM_BLE_VERSION ||
        packet.type != LM_BLE_TYPE_TEXT || packet.textLen == 0 ||
        packet.textLen > LM_TEXT_MAX || !radioTextTargetValid(packet.to)) {
      notifyTextAck(packet.from, packet.msgId, LM_BLE_TEXT_ACK_ERROR);
      return;
    }

    if (!radioSendText(packet.to, packet.text, packet.textLen, packet.msgId,
                       packet.sentAt, broadcast)) {
      notifyTextAck(packet.from, packet.msgId, LM_BLE_TEXT_ACK_ERROR);
    }
  }
};

class TextTxCallbacks : public NimBLECharacteristicCallbacks {
  void onSubscribe(NimBLECharacteristic *, NimBLEConnInfo &,
                   uint16_t subValue) override {
    g_textSubscribed = subValue != 0;
  }
};

class PeerCallbacks : public NimBLECharacteristicCallbacks {
  void onSubscribe(NimBLECharacteristic *, NimBLEConnInfo &,
                   uint16_t subValue) override {
    g_peerSubscribed = subValue != 0;
    if (g_peerSubscribed) {
      g_lastPeerAt = millis() - LM_BLE_PEER_INTERVAL_MS;
    }
  }
};

class StatusCallbacks : public NimBLECharacteristicCallbacks {
  void onRead(NimBLECharacteristic *characteristic,
              NimBLEConnInfo &) override {
    BleStatusPacket status;
    buildStatus(status);
    characteristic->setValue(reinterpret_cast<const uint8_t *>(&status),
                             sizeof(status));
  }

  void onSubscribe(NimBLECharacteristic *, NimBLEConnInfo &,
                   uint16_t subValue) override {
    g_statusSubscribed = subValue != 0;
    if (g_statusSubscribed) {
      g_lastStatusAt = millis() - LM_BLE_STATUS_INTERVAL_MS;
    }
  }
};

} // namespace

void bleBegin() {
  char deviceName[24];
  snprintf(deviceName, sizeof(deviceName), "%s%s", LM_BLE_NAME_PREFIX,
           radioNodeId());

  NimBLEDevice::init(deviceName);
  NimBLEDevice::setMTU(LM_BLE_MTU);

  g_server = NimBLEDevice::createServer();
  g_server->setCallbacks(new ServerCallbacks());

  NimBLEService *service =
      g_server->createService(LM_BLE_SERVICE_UUID);

  g_gpsRx = service->createCharacteristic(
      LM_BLE_GPS_RX_UUID,
      NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_NR);
  g_gpsRx->setCallbacks(new GpsCallbacks());

  g_peerTx = service->createCharacteristic(LM_BLE_PEER_TX_UUID,
                                           NIMBLE_PROPERTY::NOTIFY);
  g_peerTx->setCallbacks(new PeerCallbacks());

  g_status = service->createCharacteristic(
      LM_BLE_STATUS_UUID, NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY);
  g_status->setCallbacks(new StatusCallbacks());
  updateStatusValue();

  g_textRx = service->createCharacteristic(
      LM_BLE_TEXT_RX_UUID,
      NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_NR);
  g_textRx->setCallbacks(new TextRxCallbacks());

  g_textTx = service->createCharacteristic(LM_BLE_TEXT_TX_UUID,
                                           NIMBLE_PROPERTY::NOTIFY);
  g_textTx->setCallbacks(new TextTxCallbacks());

  NimBLEAdvertising *advertising = NimBLEDevice::getAdvertising();
  advertising->addServiceUUID(service->getUUID());
  advertising->setName(deviceName);
  advertising->enableScanResponse(true);
  advertising->start();

  const uint32_t now = millis();
  g_lastStatusAt = now - LM_BLE_STATUS_INTERVAL_MS;
  g_lastPeerAt = now - LM_BLE_PEER_INTERVAL_MS;
  g_bleReady = true;

  Serial.printf("[ble] advertising name=%s mtu=%d\n", deviceName, LM_BLE_MTU);
}

void bleLoop() {
  if (!g_bleReady || !g_connected) {
    return;
  }

  const uint32_t now = millis();
  if ((uint32_t)(now - g_lastStatusAt) >= LM_BLE_STATUS_INTERVAL_MS) {
    g_lastStatusAt = now;
    updateStatusValue();
    if (g_statusSubscribed) {
      g_status->notify();
    }
  }

  if ((uint32_t)(now - g_lastPeerAt) >= LM_BLE_PEER_INTERVAL_MS) {
    g_lastPeerAt = now;
    if (g_peerSubscribed) {
      RadioPeerSnapshot snapshot;
      buildPeerSnapshot(snapshot);
      g_peerTx->setValue(reinterpret_cast<const uint8_t *>(&snapshot),
                         sizeof(snapshot));
      g_peerTx->notify();
    }
  }

  if (g_textSubscribed) {
    RadioTextMessage texts[4];
    const size_t textCount = radioCopyIncomingText(texts, 4);
    for (size_t i = 0; i < textCount; i++) {
      notifyText(texts[i]);
    }

    RadioTextAck acks[4];
    const size_t ackCount = radioCopyIncomingAck(acks, 4);
    for (size_t i = 0; i < ackCount; i++) {
      notifyRadioAck(acks[i]);
    }
  }
}

#else

void bleBegin() {}

void bleLoop() {}

#endif
