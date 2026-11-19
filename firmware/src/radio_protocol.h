#pragma once

#include <stdint.h>
#include <string.h>

#include "config.h"

#define LM_RADIO_MAGIC 0x4C4D
#define LM_RADIO_VERSION 2
#define LM_RADIO_TYPE_NODE_STATUS 1
#define LM_RADIO_TYPE_PEER_SNAPSHOT 2
#define LM_RADIO_TYPE_TEXT 3
#define LM_RADIO_TYPE_TEXT_ACK 4

#define LM_RADIO_GPS_UNKNOWN 0
#define LM_RADIO_GPS_SERIAL 1
#define LM_RADIO_GPS_PHONE 2

#define LM_RADIO_TEXT_FLAG_BROADCAST 0x01
#define LM_RADIO_TEXT_ACK_RECEIVED 0
#define LM_RADIO_TEXT_ACK_ERROR 1
#define LM_RADIO_TEXT_BROADCAST_ID "*"

struct RadioNodeMessage {
  uint16_t magic;
  uint8_t version;
  uint8_t type;
  char id[LM_NODE_ID_MAX + 1];
  uint8_t hasFix;
  uint8_t satellites;
  uint8_t gpsSource;
  uint8_t reserved;
  float lat;
  float lon;
  float accuracy;
  int32_t altitudeM;
  uint32_t uptimeS;
  uint32_t seq;
  uint16_t bootId;
  uint16_t fixAgeMs;
};

struct RadioPeerEntry {
  char id[LM_NODE_ID_MAX + 1];
  uint8_t hasFix;
  uint8_t satellites;
  uint8_t gpsSource;
  uint8_t reserved;
  float lat;
  float lon;
  float accuracy;
  int32_t altitudeM;
  uint32_t uptimeS;
  uint32_t seq;
  uint16_t bootId;
  uint16_t fixAgeMs;
  uint16_t ageS;
  int8_t rssi;
};

struct RadioPeerSnapshot {
  uint16_t magic;
  uint8_t version;
  uint8_t type;
  uint8_t count;
  uint8_t reserved[3];
  uint32_t hubUptimeS;
  RadioPeerEntry peers[LM_NODE_MAX];
};

struct RadioTextMessage {
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

struct RadioTextAck {
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

static_assert(sizeof(RadioNodeMessage) <= 250,
              "ESP-NOW node payload must fit in 250 bytes");
static_assert(sizeof(RadioPeerSnapshot) <= 250,
              "ESP-NOW snapshot payload must fit in 250 bytes");
static_assert(sizeof(RadioTextMessage) == 232,
              "RadioTextMessage layout changed");
static_assert(sizeof(RadioTextMessage) <= 250,
              "ESP-NOW text payload must fit in 250 bytes");
static_assert(sizeof(RadioTextAck) == 48,
              "RadioTextAck layout changed");

inline bool radioIdValid(const char *id, size_t maxLen) {
  if (id == nullptr || id[0] == '\0') {
    return false;
  }
  size_t len = 0;
  while (len <= maxLen && id[len] != '\0') {
    const unsigned char c = (unsigned char)id[len];
    const bool ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
                    (c >= '0' && c <= '9') || c == '_' || c == '-';
    if (!ok) {
      return false;
    }
    len++;
  }
  return len > 0 && len <= maxLen;
}

inline bool radioNodeMessageValid(const RadioNodeMessage &msg) {
  return msg.magic == LM_RADIO_MAGIC && msg.version == LM_RADIO_VERSION &&
         msg.type == LM_RADIO_TYPE_NODE_STATUS &&
         radioIdValid(msg.id, LM_NODE_ID_MAX);
}

inline bool radioPeerSnapshotValid(const RadioPeerSnapshot &msg) {
  return msg.magic == LM_RADIO_MAGIC && msg.version == LM_RADIO_VERSION &&
         msg.type == LM_RADIO_TYPE_PEER_SNAPSHOT && msg.count <= LM_NODE_MAX;
}

inline bool radioTextTargetValid(const char *to) {
  if (to == nullptr) {
    return false;
  }
  if (strcmp(to, LM_RADIO_TEXT_BROADCAST_ID) == 0) {
    return true;
  }
  return radioIdValid(to, LM_NODE_ID_MAX);
}

inline bool radioTextMessageValid(const RadioTextMessage &msg) {
  return msg.magic == LM_RADIO_MAGIC && msg.version == LM_RADIO_VERSION &&
         msg.type == LM_RADIO_TYPE_TEXT &&
         radioIdValid(msg.from, LM_NODE_ID_MAX) &&
         radioTextTargetValid(msg.to) && msg.textLen > 0 &&
         msg.textLen <= LM_TEXT_MAX;
}

inline bool radioTextAckValid(const RadioTextAck &msg) {
  return msg.magic == LM_RADIO_MAGIC && msg.version == LM_RADIO_VERSION &&
         msg.type == LM_RADIO_TYPE_TEXT_ACK &&
         radioIdValid(msg.from, LM_NODE_ID_MAX) &&
         radioIdValid(msg.to, LM_NODE_ID_MAX);
}

inline const char *radioGpsSourceName(uint8_t source) {
  switch (source) {
  case LM_RADIO_GPS_SERIAL:
    return "serial";
  case LM_RADIO_GPS_PHONE:
    return "phone";
  default:
    return "unknown";
  }
}
