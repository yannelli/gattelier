#include <assert.h>
#include "../firmware/nanoscope/network_button.h"

using Event = NetworkButtonEvent;

static Event press(NetworkButton& button, uint32_t at) {
  assert(button.updateEvent(true, at) == Event::None);
  assert(button.updateEvent(true, at + 30) == Event::None);
  assert(button.updateEvent(false, at + 80) == Event::None);
  return button.updateEvent(false, at + 110);
}

int main() {
  NetworkButton button;
  button.begin(false, 0);
  assert(press(button, 100) == Event::None);
  assert(button.updateEvent(false, 609) == Event::None);
  assert(button.updateEvent(false, 610) == Event::ShortPress);
  assert(button.updateEvent(false, 611) == Event::None);
  button.begin(false, 0);
  assert(press(button, 100) == Event::None);
  assert(press(button, 250) == Event::None);
  assert(press(button, 400) == Event::TriplePress);
  assert(button.updateEvent(false, 1000) == Event::None);
  button.begin(false, 0);
  assert(button.updateEvent(true, 100) == Event::None);
  assert(button.updateEvent(true, 130) == Event::None);
  assert(button.updateEvent(true, 3129) == Event::None);
  assert(button.updateEvent(true, 3130) == Event::LongPress);
  assert(button.updateEvent(true, 7000) == Event::None);
  assert(button.updateEvent(false, 7100) == Event::None);
  assert(button.updateEvent(false, 7130) == Event::None);
  assert(button.updateEvent(false, 7600) == Event::None);
  button.begin(true, 0);
  assert(button.updateEvent(true, 5000) == Event::None);
  assert(button.updateEvent(false, 5100) == Event::None);
  assert(button.updateEvent(false, 5130) == Event::None);
  assert(press(button, 5200) == Event::None);
  assert(button.updateEvent(false, 5710) == Event::ShortPress);
  button.begin(false, UINT32_MAX - 200);
  assert(button.updateEvent(true, UINT32_MAX - 150) == Event::None);
  assert(button.updateEvent(true, UINT32_MAX - 120) == Event::None);
  assert(button.updateEvent(true, 2880) == Event::LongPress);
  button.begin(false, 0);
  assert(!button.update(true, 100)); assert(!button.update(true, 130));
  assert(!button.update(false, 200)); assert(button.update(false, 230));
  button.begin(false, 1000);
  assert(button.updateEvent(true, 1010) == Event::None);
  assert(button.updateEvent(false, 1020) == Event::None);
  assert(button.updateEvent(false, 2000) == Event::None);
}
