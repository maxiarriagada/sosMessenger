#include <Arduino.h>

#include "config.h"
#include "radio_link.h"
#include "storage.h"

#if ROLE_HUB
#include "app_lock.h"
#include "auth.h"
#include "captive_portal.h"
#include "location.h"
#include "web_server.h"
#include "wifi_ap.h"
#else
#include "ble_link.h"
#endif

static const char *roleName() {
#if ROLE_HUB
  return "hub";
#elif ROLE_NODE
  return "node";
#else
  return "unknown";
#endif
}

void setup() {
  Serial.begin(LM_SERIAL_BAUD);
  delay(200);
  Serial.printf("\n%s v%s role=%s\n", FW_NAME, FW_VERSION, roleName());

  if (!storageBegin()) {
    Serial.println("[boot] storage unavailable");
  }

#if ROLE_HUB
  if (!appLockBegin()) {
    Serial.println("[boot] app lock unavailable");
  }
  authBegin();
  locationBegin();
  wifiApBegin();
  radioBegin();
  captivePortalBegin();
  webServerBegin();
#else
  radioBegin();
  bleBegin();
#endif
}

void loop() {
  static uint32_t lastHeartbeat = 0;
  const uint32_t now = millis();

#if ROLE_HUB
  locationLoop();
  radioLoop();
  captivePortalLoop();
#else
  radioLoop();
  bleLoop();
#endif

  if (now - lastHeartbeat >= 10000) {
    lastHeartbeat = now;
    Serial.printf("[hb] uptime=%lus heap=%lu\n",
                  (unsigned long)(now / 1000),
                  (unsigned long)ESP.getFreeHeap());
  }

  delay(100);
}
