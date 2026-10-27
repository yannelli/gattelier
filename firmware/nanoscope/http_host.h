#pragma once
#include <cctype>
#include <cstddef>
#include <cstring>

// DNS rebinding delivers the attacker's own hostname in Host, so the API only answers to
// IP literals, single-label names, and suffixes that cannot be registered in public DNS.
inline bool boardHostAllowed(const char* value) {
  if (!value) return false;
  size_t length = std::strlen(value);
  if (!length || length > 253) return false;
  if (value[0] == '[') return length > 2 && std::memchr(value, ']', length) != nullptr;
  const char* colon = std::strrchr(value, ':');
  if (colon) {
    const size_t digits = length - size_t(colon - value) - 1;
    if (!digits || digits > 5) return false;
    for (const char* cursor = colon + 1; *cursor; ++cursor) if (!std::isdigit(static_cast<unsigned char>(*cursor))) return false;
    length = size_t(colon - value);
  }
  if (length && value[length - 1] == '.') --length;
  if (!length) return false;
  char host[254];
  for (size_t i = 0; i < length; ++i) {
    const unsigned char character = static_cast<unsigned char>(value[i]);
    if (!std::isalnum(character) && character != '-' && character != '.') return false;
    host[i] = char(std::tolower(character));
  }
  host[length] = 0;
  unsigned parts = 0, part = 0, digits = 0;
  bool numeric = true;
  for (size_t i = 0; i <= length && numeric; ++i) {
    if (i == length || host[i] == '.') {
      numeric = digits && part <= 255; ++parts; part = digits = 0;
    } else if (std::isdigit(static_cast<unsigned char>(host[i])) && digits < 3) { part = part * 10 + unsigned(host[i] - '0'); ++digits; }
    else numeric = false;
  }
  if (numeric) return parts == 4;
  if (!std::strchr(host, '.')) return true;
  for (const char* suffix : {".local", ".lan", ".home", ".home.arpa", ".internal", ".localdomain"}) {
    const size_t size = std::strlen(suffix);
    if (length > size && std::strcmp(host + length - size, suffix) == 0) return true;
  }
  return false;
}
