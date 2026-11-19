#pragma once

#include <Arduino.h>
#include <freertos/FreeRTOS.h>

bool appLockBegin();
bool appLockTake(TickType_t timeout);
void appLockGive();

class AppLock {
 public:
  explicit AppLock(TickType_t timeout = pdMS_TO_TICKS(1000));
  ~AppLock();

  bool locked() const { return locked_; }

 private:
  bool locked_;
};
