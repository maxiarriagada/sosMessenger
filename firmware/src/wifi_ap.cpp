#include "wifi_ap.h"

#include <WiFi.h>

#include "config.h"

static String g_ssid;

static String chipSuffix() {
  char buf[5];
  snprintf(buf, sizeof(buf), "%04X", (uint16_t)(ESP.getEfuseMac() & 0xFFFF));
  return String(buf);
}

void wifiApBegin() {
  g_ssid = String(LM_AP_PREFIX) + chipSuffix();

  WiFi.mode(WIFI_AP);
  WiFi.setSleep(false);

  if (!WiFi.softAPConfig(LM_AP_IP_ADDR, LM_AP_GATEWAY, LM_AP_SUBNET)) {
    Serial.println("[wifi] softAPConfig failed");
  }

  const bool ok = WiFi.softAP(g_ssid.c_str(), LM_AP_PASSWORD, LM_AP_CHANNEL,
                              LM_AP_HIDDEN, LM_AP_MAX_CLIENTS);
  Serial.printf("[wifi] AP %s %s, IP %s\n", g_ssid.c_str(), ok ? "up" : "FAILED",
                WiFi.softAPIP().toString().c_str());
}

IPAddress wifiApIp() {
  return WiFi.softAPIP();
}

String wifiApSsid() {
  return g_ssid;
}
