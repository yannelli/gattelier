#include "board_server.h"

void BoardServer::on(const char* path, HTTPMethod method, Handler handler) {
  routes_.push_back({String(path), method, handler});
  http_.on(path, method, handler);
}

void BoardServer::onNotFound(Handler handler) {
  notFound_ = handler; http_.onNotFound(handler);
}

void BoardServer::access(AccessHandler handler) {
  access_ = handler;
  http_.addMiddleware([this](WebServer&, Middleware::Callback next) {
    return access_(*this) ? true : next();
  });
}

String BoardServer::arg(const String& name) const {
  if (!serial_) return http_.arg(name);
  if (name == "plain") return body_;
  unsigned offset = 0;
  while (offset < query_.length()) {
    int end = query_.indexOf('&', offset);
    if (end < 0) end = query_.length();
    String pair = query_.substring(offset, end);
    int split = pair.indexOf('=');
    String key = split < 0 ? pair : pair.substring(0, split);
    if (WebServer::urlDecode(key) == name) return split < 0 ? String() : WebServer::urlDecode(pair.substring(split + 1));
    offset = unsigned(end) + 1;
  }
  return String();
}

String BoardServer::header(const String& name) const {
  if (!serial_) return http_.header(name);
  return name.equalsIgnoreCase("Content-Type") ? String("application/json") : String();
}

void BoardServer::sendHeader(const String& name, const String& value, bool first) {
  if (serial_) response_.header(name, value);
  else http_.sendHeader(name, value, first);
}

void BoardServer::setContentLength(size_t length) {
  if (serial_) streaming_ = length == CONTENT_LENGTH_UNKNOWN;
  else http_.setContentLength(length);
}

void BoardServer::send(int code, const char* type, const String& content) {
  if (!serial_) { http_.send(code, type, content); return; }
  response_.start(code, type);
  response_.data(content.c_str(), content.length());
  if (!streaming_) response_.finish();
}

void BoardServer::send_P(int code, PGM_P type, PGM_P content, size_t length) {
  if (!serial_) { http_.send_P(code, type, content, length); return; }
  response_.start(code, type); response_.data(content, length); response_.finish();
}

void BoardServer::sendContent(const char* content, size_t length) {
  if (!serial_) { http_.sendContent(content, length); return; }
  if (length) response_.data(content, length); else response_.finish();
}

size_t BoardServer::streamFile(fs::File& file, const String& type, int code) {
  if (!serial_) return http_.streamFile(file, type, code);
  response_.start(code, type.c_str());
  size_t sent = 0;
  char buffer[768];
  while (file.available() && response_.healthy()) {
    size_t count = file.read(reinterpret_cast<uint8_t*>(buffer), sizeof(buffer));
    if (!count) break;
    response_.data(buffer, count); sent += count;
  }
  response_.finish(); return sent;
}

void BoardServer::beginSerial(uint32_t id, HTTPMethod method, const String& target, const String& body) {
  serial_ = true; streaming_ = false; method_ = method; body_ = body;
  int split = target.indexOf('?');
  path_ = WebServer::urlDecode(split < 0 ? target : target.substring(0, split));
  query_ = split < 0 ? String() : target.substring(split + 1);
  response_.reset(id);
}

void BoardServer::dispatchSerial() {
  if (access_ && access_(*this)) return;
  for (const auto& route : routes_) {
    if (route.path == path_ && route.method == method_) { route.handler(); return; }
  }
  if (notFound_) notFound_();
  else send(404, "application/json", "{\"error\":\"Not found.\"}");
}

bool BoardServer::endSerial() {
  if (!response_.started()) send(500, "application/json", "{\"error\":\"Handler did not send a response.\"}");
  bool ok = response_.finish();
  serial_ = false; streaming_ = false; path_ = query_ = body_ = "";
  return ok;
}
