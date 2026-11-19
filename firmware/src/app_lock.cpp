#include "app_lock.h"

#include <freertos/semphr.h>

namespace {

SemaphoreHandle_t g_lock = nullptr;

} // namespace

bool appLockBegin() {
  if (g_lock != nullptr) {
    return true;
  }
  g_lock = xSemaphoreCreateRecursiveMutex();
  return g_lock != nullptr;
}

bool appLockTake(TickType_t timeout) {
  if (g_lock == nullptr) {
    return false;
  }
  return xSemaphoreTakeRecursive(g_lock, timeout) == pdTRUE;
}

void appLockGive() {
  if (g_lock != nullptr) {
    xSemaphoreGiveRecursive(g_lock);
  }
}

AppLock::AppLock(TickType_t timeout) : locked_(appLockTake(timeout)) {}

AppLock::~AppLock() {
  if (locked_) {
    appLockGive();
  }
}
