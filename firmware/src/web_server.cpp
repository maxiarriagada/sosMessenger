#include "web_server.h"

#include <ArduinoJson.h>
#include <LittleFS.h>
#include <WiFi.h>
#include <esp_http_server.h>
#include <esp_https_server.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>
#include <lwip/sockets.h>

#include <cstdio>
#include <cstdlib>
#include <vector>

#include "app_lock.h"
#include "auth.h"
#include "config.h"
#include "location.h"
#include "wifi_ap.h"

namespace {

httpd_handle_t g_httpServer = nullptr;
httpd_handle_t g_httpsServer = nullptr;
bool g_httpsReady = false;

std::vector<char> g_serverCert;
std::vector<char> g_serverKey;
String g_caFingerprint;

SemaphoreHandle_t g_fsMutex = nullptr;

bool fsLockTake(TickType_t timeout) {
  if (g_fsMutex == nullptr) {
    return false;
  }
  return xSemaphoreTakeRecursive(g_fsMutex, timeout) == pdTRUE;
}

void fsLockGive() {
  if (g_fsMutex != nullptr) {
    xSemaphoreGiveRecursive(g_fsMutex);
  }
}

class FsLock {
 public:
  explicit FsLock(TickType_t timeout = pdMS_TO_TICKS(1000))
      : locked_(fsLockTake(timeout)) {}

  ~FsLock() {
    if (locked_) {
      fsLockGive();
    }
  }

  bool locked() const { return locked_; }

 private:
  bool locked_;
};

const char *statusText(int code) {
  switch (code) {
  case 200:
    return "200 OK";
  case 201:
    return "201 Created";
  case 204:
    return "204 No Content";
  case 302:
    return "302 Found";
  case 400:
    return "400 Bad Request";
  case 401:
    return "401 Unauthorized";
  case 403:
    return "403 Forbidden";
  case 404:
    return "404 Not Found";
  case 405:
    return "405 Method Not Allowed";
  case 408:
    return "408 Request Timeout";
  case 409:
    return "409 Conflict";
  case 413:
    return "413 Payload Too Large";
  case 429:
    return "429 Too Many Requests";
  case 500:
    return "500 Internal Server Error";
  case 503:
    return "503 Service Unavailable";
  default:
    return "400 Bad Request";
  }
}

void addSecurityHeaders(httpd_req_t *req, bool cacheable) {
  httpd_resp_set_hdr(req, "X-Content-Type-Options", "nosniff");
  httpd_resp_set_hdr(req, "X-Frame-Options", "DENY");
  httpd_resp_set_hdr(req, "Referrer-Policy", "no-referrer");
  httpd_resp_set_hdr(
      req, "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' "
      "'unsafe-inline'; img-src 'self' data: https://tile.openstreetmap.org "
      "https://*.tile.openstreetmap.org; connect-src 'self'; font-src 'self'; "
      "manifest-src 'self'; object-src 'none'; base-uri 'none'; "
      "form-action 'self'; frame-ancestors 'none'");
  httpd_resp_set_hdr(req, "Cache-Control",
                     cacheable ? "public, max-age=31536000, immutable"
                               : "no-store");
}

esp_err_t sendJsonResponse(httpd_req_t *req, int code,
                           const JsonDocument &doc,
                           const String &setCookie = String(),
                           int retryAfter = -1) {
  String out;
  serializeJson(doc, out);

  httpd_resp_set_status(req, statusText(code));
  httpd_resp_set_type(req, "application/json; charset=utf-8");
  addSecurityHeaders(req, false);

  if (!setCookie.isEmpty()) {
    httpd_resp_set_hdr(req, "Set-Cookie", setCookie.c_str());
  }
  if (retryAfter >= 0) {
    char value[16];
    snprintf(value, sizeof(value), "%d", retryAfter);
    httpd_resp_set_hdr(req, "Retry-After", value);
  }

  return httpd_resp_send(req, out.c_str(), out.length());
}

esp_err_t sendJson(httpd_req_t *req, int code, const JsonDocument &doc) {
  return sendJsonResponse(req, code, doc);
}

esp_err_t sendJsonError(httpd_req_t *req, int code, const char *message,
                        int retryAfter = -1) {
  JsonDocument doc;
  doc["error"] = message;
  if (retryAfter >= 0) {
    doc["retry_after"] = retryAfter;
  }
  return sendJsonResponse(req, code, doc, String(), retryAfter);
}

esp_err_t sendText(httpd_req_t *req, int code, const char *text) {
  httpd_resp_set_status(req, statusText(code));
  httpd_resp_set_type(req, "text/plain; charset=utf-8");
  addSecurityHeaders(req, false);
  return httpd_resp_send(req, text, HTTPD_RESP_USE_STRLEN);
}

esp_err_t sendRedirect(httpd_req_t *req, const String &location) {
  httpd_resp_set_status(req, statusText(302));
  httpd_resp_set_hdr(req, "Location", location.c_str());
  addSecurityHeaders(req, false);
  return httpd_resp_send(req, nullptr, 0);
}

esp_err_t sendNoContent(httpd_req_t *req) {
  httpd_resp_set_status(req, statusText(204));
  addSecurityHeaders(req, false);
  return httpd_resp_send(req, nullptr, 0);
}

String requestHeader(httpd_req_t *req, const char *name, size_t maxLen) {
  const size_t len = httpd_req_get_hdr_value_len(req, name);
  if (len == 0 || len > maxLen) {
    return String();
  }

  char *buffer = static_cast<char *>(malloc(len + 1));
  if (buffer == nullptr) {
    return String();
  }

  String value;
  if (httpd_req_get_hdr_value_str(req, name, buffer, len + 1) == ESP_OK) {
    value = buffer;
  }
  free(buffer);
  return value;
}

String requestToken(httpd_req_t *req) {
  return authExtractToken(requestHeader(req, "Cookie", 512));
}

IPAddress requestIp(httpd_req_t *req) {
  struct sockaddr_in addr = {};
  socklen_t len = sizeof(addr);
  if (getpeername(httpd_req_to_sockfd(req), (struct sockaddr *)&addr, &len) !=
      0) {
    return IPAddress();
  }
  return IPAddress(reinterpret_cast<const uint8_t *>(&addr.sin_addr));
}

String requestClientId(httpd_req_t *req) {
  const size_t queryLen = httpd_req_get_url_query_len(req);
  if (queryLen == 0 || queryLen > 256) {
    return String();
  }

  char *query = static_cast<char *>(malloc(queryLen + 1));
  if (query == nullptr) {
    return String();
  }

  String clientId;
  if (httpd_req_get_url_query_str(req, query, queryLen + 1) == ESP_OK) {
    char value[LM_PHONE_ID_MAX + 1];
    if (httpd_query_key_value(query, "client_id", value, sizeof(value)) ==
        ESP_OK) {
      clientId = value;
    }
  }
  free(query);

  if (clientId.length() > LM_PHONE_ID_MAX) {
    return String();
  }
  return clientId;
}

bool isSameOrigin(httpd_req_t *req) {
  const String origin = requestHeader(req, "Origin", 128);
  if (origin.length() == 0) {
    return true;
  }
  if (origin == "null") {
    return false;
  }

  const String host = WiFi.softAPIP().toString();
  return origin == String("https://") + host ||
         origin == String("https://") + host + ":443";
}

bool requireAuth(httpd_req_t *req, AuthSessionInfo *sessionOut = nullptr) {
  const AuthSessionInfo session = authCheckSession(requestToken(req));
  if (sessionOut != nullptr) {
    *sessionOut = session;
  }
  if (!session.valid) {
    sendJsonError(req, 401, "no autenticado");
    return false;
  }
  return true;
}

bool allowAuthenticatedPost(httpd_req_t *req,
                            AuthSessionInfo *sessionOut = nullptr) {
  if (!isSameOrigin(req)) {
    sendJsonError(req, 403, "origen no permitido");
    return false;
  }
  return requireAuth(req, sessionOut);
}

int locationStatus(LocationResult result) {
  switch (result) {
  case LocationResult::Ok:
    return 200;
  case LocationResult::InvalidInput:
    return 400;
  case LocationResult::NotFound:
    return 404;
  case LocationResult::RateLimited:
    return 429;
  case LocationResult::InternalError:
    return 500;
  default:
    return 400;
  }
}

esp_err_t sendLocationError(httpd_req_t *req, LocationResult result,
                            const String &message, uint32_t retryAfter = 0) {
  JsonDocument doc;
  doc["ok"] = false;
  doc["error"] = message.length() > 0 ? message : "no se pudo completar";
  const int retrySeconds =
      result == LocationResult::RateLimited ? static_cast<int>(retryAfter) : -1;
  if (retrySeconds >= 0) {
    doc["retry_after"] = retrySeconds;
  }
  return sendJsonResponse(req, locationStatus(result), doc, String(),
                          retrySeconds);
}

bool readJsonBody(httpd_req_t *req, JsonDocument &doc, size_t maxLen) {
  if (req->content_len == 0) {
    httpd_resp_set_hdr(req, "Connection", "close");
    sendJsonError(req, 400, "cuerpo vacio");
    return false;
  }
  if (req->content_len > maxLen) {
    httpd_resp_set_hdr(req, "Connection", "close");
    sendJsonError(req, 413, "cuerpo demasiado grande");
    return false;
  }

  char buffer[256];
  String body;
  body.reserve(req->content_len);

  size_t remaining = req->content_len;
  int retries = 0;
  while (remaining > 0) {
    const size_t want = remaining < sizeof(buffer) ? remaining : sizeof(buffer);
    const int received = httpd_req_recv(req, buffer, want);
    if (received == HTTPD_SOCK_ERR_TIMEOUT) {
      if (++retries > 3) {
        httpd_resp_set_hdr(req, "Connection", "close");
        sendJsonError(req, 408, "timeout de lectura");
        return false;
      }
      continue;
    }
    if (received <= 0) {
      httpd_resp_set_hdr(req, "Connection", "close");
      sendJsonError(req, 400, "lectura incompleta");
      return false;
    }
    body.concat(buffer, received);
    remaining -= static_cast<size_t>(received);
    retries = 0;
  }

  const DeserializationError err = deserializeJson(doc, body);
  if (err) {
    httpd_resp_set_hdr(req, "Connection", "close");
    sendJsonError(req, 400, "json invalido");
    return false;
  }
  return true;
}

bool isSafePath(const String &path) {
  if (!path.startsWith("/")) {
    return false;
  }
  if (path == "/certs" || path.startsWith("/certs/")) {
    return false;
  }
  if (path.indexOf("..") >= 0 || path.indexOf('\\') >= 0) {
    return false;
  }
  if (path.indexOf("%2e") >= 0 || path.indexOf("%2E") >= 0) {
    return false;
  }
  if (path.indexOf("%5c") >= 0 || path.indexOf("%5C") >= 0) {
    return false;
  }
  if (path.endsWith(".key") || path.endsWith(".KEY")) {
    return false;
  }
  return true;
}

const char *contentTypeFor(const String &path) {
  if (path.endsWith(".html")) {
    return "text/html; charset=utf-8";
  }
  if (path.endsWith(".js")) {
    return "application/javascript; charset=utf-8";
  }
  if (path.endsWith(".css")) {
    return "text/css; charset=utf-8";
  }
  if (path.endsWith(".json")) {
    return "application/json; charset=utf-8";
  }
  if (path.endsWith(".svg")) {
    return "image/svg+xml";
  }
  if (path.endsWith(".png")) {
    return "image/png";
  }
  if (path.endsWith(".jpg") || path.endsWith(".jpeg")) {
    return "image/jpeg";
  }
  if (path.endsWith(".ico")) {
    return "image/x-icon";
  }
  if (path.endsWith(".woff2")) {
    return "font/woff2";
  }
  if (path.endsWith(".webmanifest")) {
    return "application/manifest+json";
  }
  if (path.endsWith(".txt")) {
    return "text/plain; charset=utf-8";
  }
  return "application/octet-stream";
}

bool sendFile(httpd_req_t *req, const String &path) {
  if (!isSafePath(path)) {
    return false;
  }

  FsLock lock;
  if (!lock.locked()) {
    return false;
  }

  if (!LittleFS.exists(path)) {
    return false;
  }

  File file = LittleFS.open(path, "r");
  if (!file || file.isDirectory()) {
    if (file) {
      file.close();
    }
    return false;
  }

  httpd_resp_set_status(req, statusText(200));
  httpd_resp_set_type(req, contentTypeFor(path));
  addSecurityHeaders(req, path.startsWith("/assets/"));

  char buffer[2048];
  size_t read = 0;
  while ((read = file.readBytes(buffer, sizeof(buffer))) > 0) {
    if (httpd_resp_send_chunk(req, buffer, read) != ESP_OK) {
      file.close();
      return true;
    }
  }
  file.close();

  httpd_resp_send_chunk(req, nullptr, 0);
  return true;
}

bool loadFile(const char *path, std::vector<char> &out) {
  FsLock lock;
  if (!lock.locked()) {
    return false;
  }

  File file = LittleFS.open(path, "r");
  if (!file) {
    return false;
  }
  const size_t size = file.size();
  if (size == 0) {
    file.close();
    return false;
  }

  out.resize(size + 1);
  const size_t read = file.readBytes(out.data(), size);
  file.close();
  if (read != size) {
    return false;
  }
  out[size] = '\0';
  return true;
}

String readTextFile(const char *path) {
  FsLock lock;
  if (!lock.locked()) {
    return String();
  }

  File file = LittleFS.open(path, "r");
  if (!file) {
    return String();
  }
  String text = file.readString();
  file.close();
  return text;
}

String apInstallUrl() {
  return String("http://") + WiFi.softAPIP().toString() + "/install";
}

String apHttpsUrl() {
  return String("https://") + WiFi.softAPIP().toString() + "/";
}

esp_err_t handleHealth(httpd_req_t *req) {
  JsonDocument doc;
  doc["name"] = FW_NAME;
  doc["version"] = FW_VERSION;
  doc["role"] = "hub";
  doc["api"] = 1;
  doc["https"] = g_httpsReady;
  doc["uptime_ms"] = millis();
  doc["uptime_s"] = millis() / 1000;
  doc["heap_free"] = ESP.getFreeHeap();

  uint64_t fsTotal = 0;
  uint64_t fsUsed = 0;
  {
    FsLock lock;
    if (lock.locked()) {
      fsTotal = LittleFS.totalBytes();
      fsUsed = LittleFS.usedBytes();
    }
  }
  doc["fs_total"] = fsTotal;
  doc["fs_used"] = fsUsed;

  return sendJson(req, 200, doc);
}

esp_err_t handleState(httpd_req_t *req) {
  JsonDocument doc;

  {
    AppLock lock;
    if (!lock.locked()) {
      return sendJsonError(req, 503, "servidor ocupado");
    }

    const bool configured = authConfigured();
    const bool setupOpen = authSetupOpen();
    const AuthSessionInfo session = authCheckSession(requestToken(req));

    doc["api"] = 1;
    doc["fw"]["name"] = FW_NAME;
    doc["fw"]["version"] = FW_VERSION;
    doc["fw"]["role"] = "hub";
    doc["ap"]["ssid"] = wifiApSsid();
    doc["ap"]["ip"] = WiFi.softAPIP().toString();

    doc["configured"] = configured;
    doc["setup"]["open"] = setupOpen;
    doc["setup"]["pin_required"] = false;
    doc["setup"]["expires_in"] = authSetupSecondsLeft();
    doc["setup"]["attempts_left"] = 0;
    doc["authenticated"] = session.valid;
    doc["secure"] = true;
    doc["https"] = g_httpsReady;
    if (session.valid) {
      doc["username"] = session.username;
    }

    doc["uptime_s"] = millis() / 1000;
    doc["heap_free"] = ESP.getFreeHeap();

    if (session.valid) {
      locationFillState(doc.as<JsonObject>(), requestClientId(req));
    }
  }

  return sendJson(req, 200, doc);
}

esp_err_t handleSetup(httpd_req_t *req) {
  JsonDocument input;
  if (!readJsonBody(req, input, LM_JSON_BODY_MAX)) {
    return ESP_OK;
  }
  if (!isSameOrigin(req)) {
    return sendJsonError(req, 403, "origen no permitido");
  }

  const String username = input["username"].as<String>();
  const String password = input["password"].as<String>();

  JsonDocument doc;
  String setCookie;
  String message;
  int code = 400;
  int retryAfter = -1;

  {
    AppLock lock;
    if (!lock.locked()) {
      return sendJsonError(req, 503, "servidor ocupado");
    }

    String token;
    const AuthResult result = authSetup(username, password, token, message);

    switch (result) {
    case AuthResult::Ok:
      code = 201;
      doc["ok"] = true;
      doc["configured"] = true;
      doc["username"] = username;
      setCookie = authBuildSetCookie(token, false);
      break;
    case AuthResult::InvalidInput:
      code = 400;
      break;
    case AuthResult::AlreadyConfigured:
      code = 409;
      break;
    case AuthResult::SetupClosed:
      code = 403;
      break;
    case AuthResult::InternalError:
      code = 500;
      break;
    default:
      code = 400;
      break;
    }
  }

  if (!doc["ok"].is<bool>()) {
    doc["ok"] = false;
    doc["error"] = message.length() > 0 ? message : "no se pudo completar";
  }

  return sendJsonResponse(req, code, doc, setCookie, retryAfter);
}

esp_err_t handleLogin(httpd_req_t *req) {
  JsonDocument input;
  if (!readJsonBody(req, input, LM_JSON_BODY_MAX)) {
    return ESP_OK;
  }
  if (!isSameOrigin(req)) {
    return sendJsonError(req, 403, "origen no permitido");
  }

  const String username = input["username"].as<String>();
  const String password = input["password"].as<String>();
  const IPAddress clientIp = requestIp(req);

  JsonDocument doc;
  String setCookie;
  String message;
  int code = 401;
  int retryAfterSeconds = -1;

  {
    AppLock lock;
    if (!lock.locked()) {
      return sendJsonError(req, 503, "servidor ocupado");
    }

    String token;
    uint32_t retryAfter = 0;
    const AuthResult result =
        authLogin(username, password, clientIp, token, message, retryAfter);

    switch (result) {
    case AuthResult::Ok:
      code = 200;
      doc["ok"] = true;
      doc["authenticated"] = true;
      doc["username"] = username;
      setCookie = authBuildSetCookie(token, false);
      break;
    case AuthResult::NotConfigured:
      code = 409;
      break;
    case AuthResult::InvalidCredentials:
      code = 401;
      break;
    case AuthResult::RateLimited:
      code = 429;
      retryAfterSeconds =
          retryAfter > 0 ? static_cast<int>(retryAfter)
                         : static_cast<int>(LM_LOGIN_BLOCK_MS / 1000UL);
      break;
    case AuthResult::InternalError:
      code = 500;
      break;
    default:
      code = 400;
      break;
    }
  }

  if (code != 200) {
    doc["ok"] = false;
    doc["error"] = message.length() > 0 ? message : "no se pudo iniciar sesion";
  }

  return sendJsonResponse(req, code, doc, setCookie, retryAfterSeconds);
}

esp_err_t handleLogout(httpd_req_t *req) {
  if (!isSameOrigin(req)) {
    return sendJsonError(req, 403, "origen no permitido");
  }

  String setCookie;
  {
    AppLock lock;
    if (!lock.locked()) {
      return sendJsonError(req, 503, "servidor ocupado");
    }
    authLogout(requestToken(req));
    setCookie = authBuildSetCookie(String(), true);
  }

  JsonDocument doc;
  doc["ok"] = true;
  doc["authenticated"] = false;
  return sendJsonResponse(req, 200, doc, setCookie);
}

esp_err_t handleLocationActive(httpd_req_t *req) {
  JsonDocument input;
  if (!readJsonBody(req, input, LM_JSON_BODY_MAX)) {
    return ESP_OK;
  }

  const String source = input["source"].as<String>();
  String message;
  LocationResult result = LocationResult::InternalError;
  JsonDocument doc;

  {
    AppLock lock;
    if (!lock.locked()) {
      return sendJsonError(req, 503, "servidor ocupado");
    }
    if (!allowAuthenticatedPost(req)) {
      return ESP_OK;
    }

    result = locationSetSelectedSource(source, message);
    if (result == LocationResult::Ok) {
      doc["ok"] = true;
      doc["selected"] = locationSelectedSource();
    }
  }

  if (result != LocationResult::Ok) {
    return sendLocationError(req, result, message);
  }
  return sendJson(req, 200, doc);
}

esp_err_t handleLocationManual(httpd_req_t *req) {
  JsonDocument input;
  if (!readJsonBody(req, input, LM_JSON_BODY_MAX)) {
    return ESP_OK;
  }

  if (!input["lat"].is<double>() || !input["lon"].is<double>()) {
    return sendLocationError(req, LocationResult::InvalidInput,
                             "lat y lon son obligatorios");
  }

  float accuracy = 0;
  if (!input["accuracy"].isNull()) {
    if (!input["accuracy"].is<double>()) {
      return sendLocationError(req, LocationResult::InvalidInput,
                               "precision invalida");
    }
    accuracy = static_cast<float>(input["accuracy"].as<double>());
  }

  String message;
  LocationResult result = LocationResult::InternalError;
  JsonDocument doc;

  {
    AppLock lock;
    if (!lock.locked()) {
      return sendJsonError(req, 503, "servidor ocupado");
    }
    if (!allowAuthenticatedPost(req)) {
      return ESP_OK;
    }

    result = locationSetManual(input["lat"].as<double>(),
                               input["lon"].as<double>(), accuracy, message);
    if (result == LocationResult::Ok) {
      doc["ok"] = true;
      doc["selected"] = locationSelectedSource();
    }
  }

  if (result != LocationResult::Ok) {
    return sendLocationError(req, result, message);
  }
  return sendJson(req, 200, doc);
}

esp_err_t handleLocationPhone(httpd_req_t *req) {
  JsonDocument input;
  if (!readJsonBody(req, input, LM_JSON_BODY_MAX)) {
    return ESP_OK;
  }

  const String clientId = input["client_id"].as<String>();
  const String label = input["label"].as<String>();
  const bool hasLat = input["lat"].is<double>();
  const bool hasLon = input["lon"].is<double>();

  if (hasLat != hasLon) {
    return sendLocationError(req, LocationResult::InvalidInput,
                             "lat y lon deben enviarse juntos");
  }

  float accuracy = 0;
  if (hasLat && !input["accuracy"].isNull()) {
    if (!input["accuracy"].is<double>()) {
      return sendLocationError(req, LocationResult::InvalidInput,
                               "precision invalida");
    }
    accuracy = static_cast<float>(input["accuracy"].as<double>());
  }

  const IPAddress clientIp = requestIp(req);
  const String userAgent = requestHeader(req, "User-Agent", 200);

  uint32_t retryAfter = 0;
  String message;
  LocationResult result = LocationResult::InternalError;
  JsonDocument doc;

  {
    AppLock lock;
    if (!lock.locked()) {
      return sendJsonError(req, 503, "servidor ocupado");
    }
    if (!allowAuthenticatedPost(req)) {
      return ESP_OK;
    }

    result = locationUpdatePhone(
        clientId, label, clientIp, userAgent, hasLat,
        hasLat ? input["lat"].as<double>() : 0.0,
        hasLon ? input["lon"].as<double>() : 0.0, accuracy, retryAfter, message);
    if (result == LocationResult::Ok) {
      doc["ok"] = true;
      doc["client_id"] = clientId;
      doc["has_fix"] = hasLat;
    }
  }

  if (result != LocationResult::Ok) {
    return sendLocationError(req, result, message, retryAfter);
  }
  return sendJson(req, 200, doc);
}

esp_err_t handleLocationRequest(httpd_req_t *req) {
  JsonDocument input;
  if (!readJsonBody(req, input, LM_JSON_BODY_MAX)) {
    return ESP_OK;
  }

  const String target = input["target"].as<String>();
  String message;
  LocationResult result = LocationResult::InternalError;
  JsonDocument doc;

  {
    AppLock lock;
    if (!lock.locked()) {
      return sendJsonError(req, 503, "servidor ocupado");
    }

    AuthSessionInfo session;
    if (!allowAuthenticatedPost(req, &session)) {
      return ESP_OK;
    }

    result = locationCreateRequest(target, session.username, message);
    if (result == LocationResult::Ok) {
      doc["ok"] = true;
      doc["target"] = target;
    }
  }

  if (result != LocationResult::Ok) {
    return sendLocationError(req, result, message);
  }
  return sendJson(req, 200, doc);
}

esp_err_t handleLocationClear(httpd_req_t *req) {
  JsonDocument input;
  if (!readJsonBody(req, input, LM_JSON_BODY_MAX)) {
    return ESP_OK;
  }

  const String source = input["source"].as<String>();
  String message;
  LocationResult result = LocationResult::InternalError;
  JsonDocument doc;

  {
    AppLock lock;
    if (!lock.locked()) {
      return sendJsonError(req, 503, "servidor ocupado");
    }
    if (!allowAuthenticatedPost(req)) {
      return ESP_OK;
    }

    result = locationClear(source, message);
    if (result == LocationResult::Ok) {
      doc["ok"] = true;
      doc["selected"] = locationSelectedSource();
    }
  }

  if (result != LocationResult::Ok) {
    return sendLocationError(req, result, message);
  }
  return sendJson(req, 200, doc);
}

esp_err_t handleCaDownload(httpd_req_t *req) {
  const String pem = readTextFile(LM_CA_CERT_PATH);
  if (pem.isEmpty()) {
    return sendText(req, 404, "CA not found");
  }

  httpd_resp_set_status(req, statusText(200));
  httpd_resp_set_type(req, "application/x-x509-ca-cert");
  httpd_resp_set_hdr(req, "Content-Disposition",
                     "attachment; filename=\"lora-ca.crt\"");
  addSecurityHeaders(req, false);
  return httpd_resp_send(req, pem.c_str(), pem.length());
}

esp_err_t handleInstall(httpd_req_t *req) {
  String fingerprint = readTextFile(LM_CA_FINGERPRINT_PATH);
  fingerprint.trim();
  if (fingerprint.isEmpty()) {
    fingerprint = "no disponible";
  }

  String httpsCard;
  if (g_httpsReady) {
    httpsCard = String("<p class=\"ok\">HTTPS disponible.</p>"
                       "<p><a class=\"button\" href=\"") +
                apHttpsUrl() + "\">Abrir la app segura</a></p>";
  } else {
    httpsCard =
        "<p class=\"bad\">HTTPS no esta disponible. Revisa los certificados "
        "en LittleFS.</p>";
  }

  String html = R"HTML(<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Instalar CA - LoRaMessenger</title>
<style>
body{font-family:system-ui,-apple-system,sans-serif;margin:0;padding:24px;background:#101820;color:#e8eef3}
main{max-width:720px;margin:0 auto}
h1{font-size:1.4rem;margin:0 0 8px}
h2{font-size:1rem;margin:0 0 10px;color:#9fb3c8}
p,li{line-height:1.5}
code{background:#1b2836;padding:2px 5px;border-radius:4px;word-break:break-all}
.card{background:#16232f;border:1px solid #273b4d;border-radius:10px;padding:16px;margin:12px 0}
.button{display:inline-block;background:#2f80ed;color:#fff;text-decoration:none;border-radius:8px;padding:12px 16px;font-weight:600}
a{color:#7cc4ff}
.muted{color:#9fb3c8}
.ok{color:#6ee7a8}
.bad{color:#ff8a8a}
ol,ul{padding-left:22px}
</style>
</head>
<body>
<main>
<h1>Instalar certificado CA</h1>
<p>El hub usa un certificado HTTPS firmado por una CA local. Instala esta CA una sola vez para que el telefono confie en <code>https://%%HOST%%</code>.</p>

<div class="card">
<h2>1. Descargar el certificado</h2>
<p><a class="button" href="/ca.crt" download="lora-ca.crt">Descargar lora-ca.crt</a></p>
<p class="muted">SHA-256:<br><code>%%FINGERPRINT%%</code></p>
</div>

<div class="card">
<h2>2. Instalar en Android</h2>
<ol>
<li>Abre <b>Ajustes &rarr; Seguridad &rarr; Cifrado y credenciales &rarr; Instalar certificado</b>.</li>
<li>Elige <b>Certificado CA</b> y luego <b>Instalar de todos modos</b>.</li>
<li>Busca <code>lora-ca.crt</code> en Descargas y confirma con tu PIN/patron.</li>
<li>Verifica que el fingerprint coincida con el de arriba.</li>
</ol>
</div>

<div class="card">
<h2>2. Instalar en iPhone</h2>
<ol>
<li>Descarga el archivo con Safari y permite la descarga del perfil.</li>
<li>Ve a <b>Ajustes &rarr; General &rarr; VPN y gestion de dispositivos</b> e instala el perfil.</li>
<li>Luego abre <b>Ajustes &rarr; General &rarr; Informacion &rarr; Ajustes de confianza de certificados</b>.</li>
<li>Activa la confianza total para <b>LoRaMessenger Local CA</b>.</li>
</ol>
</div>

<div class="card">
<h2>3. Abrir la app segura</h2>
%%HTTPS_CARD%%
<p class="muted">Si Android no llega a <code>%%HOST%%</code>, habilita "Dispositivos cercanos" / "Red local" para Chrome y reinicialo.</p>
</div>

<p class="muted">Instala esta CA solo si confias en el hub LoRaMessenger. Puedes quitarla despues desde la configuracion de certificados del telefono.</p>
</main>
</body>
</html>)HTML";

  html.replace("%%HOST%%", WiFi.softAPIP().toString());
  html.replace("%%FINGERPRINT%%", fingerprint);
  html.replace("%%HTTPS_CARD%%", httpsCard);

  httpd_resp_set_status(req, statusText(200));
  httpd_resp_set_type(req, "text/html; charset=utf-8");
  addSecurityHeaders(req, false);
  return httpd_resp_send(req, html.c_str(), html.length());
}

esp_err_t handleHttpRoot(httpd_req_t *req) {
  return sendRedirect(req, String("/install"));
}

esp_err_t handleHttpTlsTest(httpd_req_t *req) {
  return sendRedirect(req, apHttpsUrl());
}

esp_err_t handleHttpsTlsTest(httpd_req_t *req) {
  return sendRedirect(req, String("/"));
}

esp_err_t handleCaptiveHttp(httpd_req_t *req) {
  return sendRedirect(req, apInstallUrl());
}

esp_err_t handleCaptiveHttps(httpd_req_t *req) {
  return sendRedirect(req, apHttpsUrl());
}

esp_err_t handleHttpNotFound(httpd_req_t *req) {
  const String path = req->uri;

  if (req->method != HTTP_GET) {
    if (path == "/api" || path.startsWith("/api/")) {
      return sendJsonError(req, 405, "method not allowed");
    }
    return sendText(req, 405, "method not allowed");
  }

  if (path == "/api" || path.startsWith("/api/")) {
    return sendJsonError(req, 404, "https required");
  }

  if (path == "/favicon.ico") {
    return sendNoContent(req);
  }

  const String message = String("Solo instalacion: ") + apInstallUrl();
  return sendText(req, 404, message.c_str());
}

esp_err_t handleStaticHttps(httpd_req_t *req) {
  const String path = req->uri;

  if (req->method != HTTP_GET) {
    if (path == "/api" || path.startsWith("/api/")) {
      return sendJsonError(req, 405, "method not allowed");
    }
    return sendText(req, 405, "method not allowed");
  }

  if (path == "/api" || path.startsWith("/api/")) {
    return sendJsonError(req, 404, "not found");
  }

  if (path == "/favicon.ico") {
    return sendNoContent(req);
  }

  if (!isSafePath(path)) {
    return sendText(req, 404, "not found");
  }

  String file = path;
  if (file.endsWith("/")) {
    file += "index.html";
  }

  if (sendFile(req, file)) {
    return ESP_OK;
  }

  if (file.indexOf('.') >= 0) {
    return sendText(req, 404, "not found");
  }

  if (sendFile(req, "/index.html")) {
    return ESP_OK;
  }

  return sendText(req, 404,
                  "LittleFS is empty. Run: pio run -e hub -t uploadfs");
}

bool addRoute(httpd_handle_t server, const char *uri, httpd_method_t method,
              esp_err_t (*handler)(httpd_req_t *)) {
  httpd_uri_t route = {};
  route.uri = uri;
  route.method = method;
  route.handler = handler;
  route.user_ctx = nullptr;

  const esp_err_t err = httpd_register_uri_handler(server, &route);
  if (err != ESP_OK) {
    Serial.printf("[web] route %s failed: %s\n", uri, esp_err_to_name(err));
  }
  return err == ESP_OK;
}

bool registerHttpRoutes() {
  bool ok = true;
  ok &= addRoute(g_httpServer, "/", HTTP_GET, handleHttpRoot);
  ok &= addRoute(g_httpServer, "/install", HTTP_GET, handleInstall);
  ok &= addRoute(g_httpServer, "/ca.crt", HTTP_GET, handleCaDownload);
  ok &= addRoute(g_httpServer, "/tls-test", HTTP_GET, handleHttpTlsTest);

  static const char *captivePaths[] = {
      "/generate_204",
      "/hotspot-detect.html",
      "/library/test/success.html",
      "/connecttest.txt",
      "/ncsi.txt",
      "/canonical.html",
      "/success.txt",
  };
  for (const char *path : captivePaths) {
    ok &= addRoute(g_httpServer, path, HTTP_GET, handleCaptiveHttp);
  }

  ok &= addRoute(g_httpServer, "/*",
                 static_cast<httpd_method_t>(HTTP_ANY), handleHttpNotFound);
  return ok;
}

bool registerHttpsRoutes() {
  bool ok = true;
  ok &= addRoute(g_httpsServer, "/api/health", HTTP_GET, handleHealth);
  ok &= addRoute(g_httpsServer, "/api/state", HTTP_GET, handleState);
  ok &= addRoute(g_httpsServer, "/api/setup", HTTP_POST, handleSetup);
  ok &= addRoute(g_httpsServer, "/api/login", HTTP_POST, handleLogin);
  ok &= addRoute(g_httpsServer, "/api/logout", HTTP_POST, handleLogout);
  ok &= addRoute(g_httpsServer, "/api/location/active", HTTP_POST,
                 handleLocationActive);
  ok &= addRoute(g_httpsServer, "/api/location/manual", HTTP_POST,
                 handleLocationManual);
  ok &= addRoute(g_httpsServer, "/api/location/phone", HTTP_POST,
                 handleLocationPhone);
  ok &= addRoute(g_httpsServer, "/api/location/request", HTTP_POST,
                 handleLocationRequest);
  ok &= addRoute(g_httpsServer, "/api/location/clear", HTTP_POST,
                 handleLocationClear);
  ok &= addRoute(g_httpsServer, "/install", HTTP_GET, handleInstall);
  ok &= addRoute(g_httpsServer, "/ca.crt", HTTP_GET, handleCaDownload);
  ok &= addRoute(g_httpsServer, "/favicon.ico", HTTP_GET, sendNoContent);
  ok &= addRoute(g_httpsServer, "/tls-test", HTTP_GET, handleHttpsTlsTest);

  static const char *captivePaths[] = {
      "/generate_204",
      "/hotspot-detect.html",
      "/library/test/success.html",
      "/connecttest.txt",
      "/ncsi.txt",
      "/canonical.html",
      "/success.txt",
  };
  for (const char *path : captivePaths) {
    ok &= addRoute(g_httpsServer, path, HTTP_GET, handleCaptiveHttps);
  }

  ok &= addRoute(g_httpsServer, "/*",
                 static_cast<httpd_method_t>(HTTP_ANY), handleStaticHttps);
  return ok;
}

bool startHttpServer() {
  httpd_config_t config = HTTPD_DEFAULT_CONFIG();
  config.server_port = LM_HTTP_PORT;
  config.ctrl_port = LM_HTTP_CTRL_PORT;
  config.max_uri_handlers = LM_MAX_URI_HANDLERS;
  config.max_resp_headers = LM_MAX_RESP_HEADERS;
  config.max_open_sockets = LM_HTTP_MAX_SOCKETS;
  config.lru_purge_enable = true;
  config.keep_alive_enable = true;
  config.keep_alive_idle = 5;
  config.keep_alive_interval = 5;
  config.keep_alive_count = 5;
  config.stack_size = LM_HTTP_STACK_SIZE;
  config.uri_match_fn = httpd_uri_match_wildcard;

  const esp_err_t err = httpd_start(&g_httpServer, &config);
  if (err != ESP_OK) {
    Serial.printf("[web] HTTP start failed: %s\n", esp_err_to_name(err));
    g_httpServer = nullptr;
    return false;
  }

  return registerHttpRoutes();
}

bool startHttpsServer() {
  if (!loadFile(LM_TLS_CERT_PATH, g_serverCert)) {
    Serial.println("[web] missing /certs/server.crt");
    return false;
  }
  if (!loadFile(LM_TLS_KEY_PATH, g_serverKey)) {
    Serial.println("[web] missing /certs/server.key");
    return false;
  }

  httpd_ssl_config_t config = HTTPD_SSL_CONFIG_DEFAULT();
  config.httpd.ctrl_port = LM_HTTPS_CTRL_PORT;
  config.httpd.max_uri_handlers = LM_MAX_URI_HANDLERS;
  config.httpd.max_resp_headers = LM_MAX_RESP_HEADERS;
  config.httpd.max_open_sockets = LM_HTTPS_MAX_SOCKETS;
  config.httpd.lru_purge_enable = true;
  config.httpd.keep_alive_enable = true;
  config.httpd.keep_alive_idle = 5;
  config.httpd.keep_alive_interval = 5;
  config.httpd.keep_alive_count = 5;
  config.httpd.stack_size = LM_HTTPS_STACK_SIZE;
  config.httpd.uri_match_fn = httpd_uri_match_wildcard;
  config.session_tickets = false;
  config.port_secure = LM_HTTPS_PORT;
  config.servercert =
      reinterpret_cast<const uint8_t *>(g_serverCert.data());
  config.servercert_len = g_serverCert.size();
  config.prvtkey_pem =
      reinterpret_cast<const uint8_t *>(g_serverKey.data());
  config.prvtkey_len = g_serverKey.size();
  config.tls_handshake_timeout_ms = 10000;

  const esp_err_t err = httpd_ssl_start(&g_httpsServer, &config);
  if (err != ESP_OK) {
    Serial.printf("[web] HTTPS start failed: %s\n", esp_err_to_name(err));
    g_httpsServer = nullptr;
    g_httpsReady = false;
    return false;
  }

  g_httpsReady = true;
  return registerHttpsRoutes();
}

} // namespace

void webServerBegin() {
  if (g_fsMutex == nullptr) {
    g_fsMutex = xSemaphoreCreateRecursiveMutex();
  }
  if (g_fsMutex == nullptr) {
    Serial.println("[web] filesystem lock unavailable");
  }

  g_caFingerprint = readTextFile(LM_CA_FINGERPRINT_PATH);
  g_caFingerprint.trim();

  const bool httpOk = startHttpServer();
  const bool httpsOk = startHttpsServer();

  const String host = WiFi.softAPIP().toString();
  if (httpOk) {
    Serial.printf("[web] http://%s/install\n", host.c_str());
  } else {
    Serial.println("[web] HTTP unavailable");
  }

  if (httpsOk) {
    Serial.printf("[web] https://%s/ ca=%s\n", host.c_str(),
                  g_caFingerprint.c_str());
  } else {
    Serial.println("[web] HTTPS unavailable; HTTP install only");
  }
}
