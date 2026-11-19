#pragma once

#include <stdint.h>

#include "config.h"

#define LM_BLE_MAGIC 0x4C42
#define LM_BLE_VERSION 1
#define LM_BLE_TYPE_GPS 1
#define LM_BLE_TYPE_STATUS 2
#define LM_BLE_TYPE_TEXT 3
#define LM_BLE_TYPE_TEXT_ACK 4

#define LM_BLE_GPS_FLAG_VALID 0x01
#define LM_BLE_TEXT_FLAG_BROADCAST 0x01
#define LM_BLE_TEXT_ACK_RECEIVED 0
#define LM_BLE_TEXT_ACK_ERROR 1

#define LM_BLE_SERVICE_UUID "4c4d0001-9a1b-4c6d-8e2f-1a2b3c4d5e6f"
#define LM_BLE_GPS_RX_UUID "4c4d0002-9a1b-4c6d-8e2f-1a2b3c4d5e6f"
#define LM_BLE_PEER_TX_UUID "4c4d0003-9a1b-4c6d-8e2f-1a2b3c4d5e6f"
#define LM_BLE_STATUS_UUID "4c4d0004-9a1b-4c6d-8e2f-1a2b3c4d5e6f"
#define LM_BLE_TEXT_RX_UUID "4c4d0005-9a1b-4c6d-8e2f-1a2b3c4d5e6f"
#define LM_BLE_TEXT_TX_UUID "4c4d0006-9a1b-4c6d-8e2f-1a2b3c4d5e6f"

struct BleGpsPacket {
  uint16_t magic;
  uint8_t version;
  uint8_t type;
  uint32_t seq;
  float lat;
  float lon;
  float accuracy;
  int32_t altitudeM;
  uint16_t fixAgeMs;
  uint8_t satellites;
  uint8_t flags;
};

struct BleStatusPacket {
  uint16_t magic;
  uint8_t version;
  uint8_t type;
  char nodeId[LM_NODE_ID_MAX + 1];
  uint8_t hasFix;
  uint8_t gpsSource;
  uint8_t satellites;
  uint8_t peerCount;
  uint8_t reserved[3];
  float lat;
  float lon;
  float accuracy;
  int32_t altitudeM;
  uint16_t fixAgeMs;
  uint16_t bootId;
  uint32_t uptimeS;
  uint32_t seq;
};

struct BleTextPacket {
  uint16_t magic;
  uint8_t version;
  uint8_t type;
  uint32_t msgId;
  uint32_t sentAt;
  char from[LM_NODE_ID_MAX + 1];
  char to[LM_NODE_ID_MAX + 1];
  uint16_t fromBootId;
  uint8_t ttl;
  uint8_t flags;
  uint8_t textLen;
  uint8_t reserved;
  char text[LM_TEXT_MAX];
};

struct BleTextAckPacket {
  uint16_t magic;
  uint8_t version;
  uint8_t type;
  uint32_t msgId;
  char from[LM_NODE_ID_MAX + 1];
  char to[LM_NODE_ID_MAX + 1];
  uint16_t fromBootId;
  uint8_t status;
  uint8_t reserved[3];
};

static_assert(sizeof(BleGpsPacket) == 28, "BleGpsPacket layout changed");
static_assert(sizeof(BleStatusPacket) == 56, "BleStatusPacket layout changed");
static_assert(sizeof(BleTextPacket) == 232, "BleTextPacket layout changed");
static_assert(sizeof(BleTextPacket) <= 244, "BleTextPacket exceeds BLE MTU");
static_assert(sizeof(BleTextAckPacket) == 48, "BleTextAckPacket layout changed");
