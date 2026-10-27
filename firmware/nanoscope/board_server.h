#pragma once
#include <WebServer.h>
#include <vector>
#include "serial_api_response.h"

class BoardServer {
public:
  using Handler = WebServer::THandlerFunction;
  using AccessHandler = std::function<bool(BoardServer&)>;
  explicit BoardServer(int port) : http_(port) {}
  void on(const char* path, HTTPMethod method, Handler handler);
  void onNotFound(Handler handler);
  void access(AccessHandler handler);
  void collectHeaders(const char* keys[], size_t count) { http_.collectHeaders(keys, count); }
  void begin() { http_.begin(); }
  void stop() { http_.client().stop(); http_.stop(); }
  void handleClient() { http_.handleClient(); }
  String arg(const String& name) const;
  String header(const String& name) const;
  String hostHeader() const { return serial_ ? String() : http_.hostHeader(); }
  bool viaSerial() const { return serial_; }
  String uri() const { return serial_ ? path_ : http_.uri(); }
  HTTPMethod method() const { return serial_ ? method_ : http_.method(); }
  void sendHeader(const String& name, const String& value, bool first = false);
  void setContentLength(size_t length);
  void send(int code, const char* type = nullptr, const String& content = String());
  void send_P(int code, PGM_P type, PGM_P content, size_t length);
  void sendContent(const String& content) { sendContent(content.c_str(), content.length()); }
  void sendContent(const char* content, size_t length);
  size_t streamFile(fs::File& file, const String& type, int code = 200);
  void beginSerial(uint32_t id, HTTPMethod method, const String& target, const String& body);
  void dispatchSerial();
  bool endSerial();
private:
  struct Route { String path; HTTPMethod method; Handler handler; };
  WebServer http_;
  std::vector<Route> routes_;
  Handler notFound_;
  AccessHandler access_;
  SerialApiResponse response_;
  bool serial_ = false, streaming_ = false;
  HTTPMethod method_ = HTTP_GET;
  String path_, query_, body_;
};
