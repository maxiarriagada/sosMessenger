#include "storage.h"

#include <LittleFS.h>

#include "config.h"

bool storageBegin() {
  if (!LittleFS.begin(true)) {
    Serial.println("[fs] LittleFS mount failed");
    return false;
  }

  Serial.printf("[fs] mounted: %u/%u bytes used\n",
                (unsigned)LittleFS.usedBytes(),
                (unsigned)LittleFS.totalBytes());
  return true;
}

size_t storageTotalBytes() {
  return LittleFS.totalBytes();
}

size_t storageUsedBytes() {
  return LittleFS.usedBytes();
}
