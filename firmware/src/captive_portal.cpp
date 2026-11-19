#include "captive_portal.h"

#include <DNSServer.h>
#include <WiFi.h>

static DNSServer dnsServer;

void captivePortalBegin() {
  const IPAddress apIp = WiFi.softAPIP();

  dnsServer.setErrorReplyCode(DNSReplyCode::NoError);
  const bool ok = dnsServer.start(53, "*", apIp);

  Serial.printf("[dns] captive portal %s on %s:53\n", ok ? "up" : "FAILED",
                apIp.toString().c_str());
}

void captivePortalLoop() {
  dnsServer.processNextRequest();
}
