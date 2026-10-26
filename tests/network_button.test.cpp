#include <assert.h>
#include "../firmware/nanoscope/network_button.h"

int main() {
  NetworkButton button;
  button.begin(false, 0);
  assert(!button.update(true, 10));
  assert(!button.update(false, 20));
  assert(!button.update(false, 100));
  assert(!button.update(true, 200));
  assert(!button.update(true, 229));
  assert(!button.update(true, 230));
  assert(!button.update(false, 250));
  assert(!button.update(true, 260));
  assert(!button.update(false, 270));
  assert(!button.update(false, 299));
  assert(button.update(false, 300));
  assert(!button.update(false, 301));
  assert(!button.update(false, 900));

  button.begin(true, 1000);
  assert(!button.update(true, 9000));
  assert(!button.update(false, 9010));
  assert(!button.update(false, 9040));
  assert(!button.update(true, 9100));
  assert(!button.update(true, 9130));
  assert(!button.update(false, 9200));
  assert(button.update(false, 9230));

  button.begin(false, 10000);
  assert(!button.update(true, 10100));
  assert(!button.update(true, 10130));
  assert(!button.update(false, 12100));
  assert(!button.update(false, 12130));
  button.begin(false, UINT32_MAX - 100);
  assert(!button.update(true, UINT32_MAX - 50));
  assert(!button.update(true, UINT32_MAX - 20));
  assert(!button.update(false, 20));
  assert(button.update(false, 50));
}
