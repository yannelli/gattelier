#pragma once
#include <Arduino.h>
#include <cJSON.h>

class SerialApiResponse {
public:
  static constexpr size_t MaxBytes = 2097152;
  void reset(uint32_t id);
  void header(const String& name, const String& value);
  void start(int status, const char* type);
  void data(const char* bytes, size_t length);
  bool finish();
  bool started() const { return started_; }
  bool healthy() const { return !failed_ && error_.isEmpty(); }
private:
  bool write(const char* bytes, size_t length);
  bool frame(cJSON* json);
  cJSON* event(const char* name);
  uint32_t id_ = 0, startedAt_ = 0;
  size_t bytes_ = 0;
  bool started_ = false, ended_ = false, failed_ = false;
  String disposition_, error_;
};
