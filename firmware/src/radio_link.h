#pragma once

#include <Arduino.h>

#include "config.h"
#include "radio_protocol.h"

void radioBegin();
void radioLoop();

#if ROLE_NODE
const char *radioNodeId();
bool radioSetPhoneFix(double lat, double lon, float accuracy, int32_t altitudeM,
                      uint16_t fixAgeMs, uint8_t satellites, uint32_t seq);
void radioClearPhoneFix();
void radioFillNodeMessage(RadioNodeMessage &msg);
size_t radioCopyPeers(RadioPeerEntry *out, size_t maxCount);
bool radioSendText(const char *to, const char *text, size_t textLen,
                   uint32_t msgId, uint32_t sentAt, bool broadcast);
size_t radioCopyIncomingText(RadioTextMessage *out, size_t maxCount);
size_t radioCopyIncomingAck(RadioTextAck *out, size_t maxCount);
#endif
