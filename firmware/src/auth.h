#pragma once

#include <Arduino.h>
#include <IPAddress.h>

enum class AuthResult : uint8_t {
  Ok = 0,
  InvalidInput,
  NotConfigured,
  AlreadyConfigured,
  SetupClosed,
  InvalidCredentials,
  RateLimited,
  InternalError,
};

struct AuthSessionInfo {
  bool valid = false;
  String username;
  uint32_t ageSeconds = 0;
};

bool authBegin();

AuthResult authSetup(const String &username, const String &password,
                     String &tokenOut, String &messageOut);

AuthResult authLogin(const String &username, const String &password,
                     const IPAddress &clientIp, String &tokenOut,
                     String &messageOut, uint32_t &retryAfterOut);

bool authLogout(const String &token);
AuthSessionInfo authCheckSession(const String &token);

bool authConfigured();
bool authSetupOpen();
uint32_t authSetupSecondsLeft();

String authExtractToken(const String &cookieHeader);
String authBuildSetCookie(const String &token, bool clear);
