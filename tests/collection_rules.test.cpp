#include <assert.h>
#include "../firmware/nanoscope/collection_rules.h"

int main() {
  CollectionConfig config;
  assert(!validateCollection(config));
  assert(!collectionBurstDue(config, 100, 0));
  config.enabled = true;
  assert(collectionBurstDue(config, 100, 0));
  config.periodMs = 60000; config.burstMs = 10000;
  assert(collectionBurstDue(config, 1000, 1000));
  assert(collectionBurstDue(config, 10999, 1000));
  assert(!collectionBurstDue(config, 11000, 1000));
  assert(!collectionBurstDue(config, 60999, 1000));
  assert(collectionBurstDue(config, 61000, 1000));
  assert(collectionBurstDue(config, 50, UINT32_MAX - 50));
  config.windowMs = config.intervalMs + 1; assert(validateCollection(config));
  config.windowMs = 5; config.intervalMs = 10; assert(!validateCollection(config));
  config.intervalMs = 9; assert(validateCollection(config)); config.intervalMs = 160;
  config.burstMs = 60001; assert(validateCollection(config)); config.burstMs = 10000;
  strcpy(config.address, "aa:bb:cc:dd:ee:ff"); assert(!validateCollection(config));
  config.address[3] = 'z'; assert(validateCollection(config));
  memset(config.address, 'a', sizeof(config.address)); assert(validateCollection(config));
  assert(collectionFits(0, 2048));
  assert(!collectionFits(0, 2049));
  assert(collectionFits(CollectionLogLimit - 11, 10));
  assert(!collectionFits(CollectionLogLimit - 10, 10));
  assert(!collectionFits(CollectionLogLimit + 1, 0));
  assert(!collectionFits(SIZE_MAX, 10));
  assert(collectionColor(false, false, 0x201000, 0) == 0x201000);
  assert(collectionColor(true, false, 0x000020, 0) == 0x002018);
  assert(collectionColor(true, false, 0x000020, 150) == 0x000020);
  assert(collectionColor(true, false, 0x201000, 250) == 0x002018);
  assert(collectionColor(true, false, 0x201000, 500) == 0x201000);
  assert(collectionColor(true, true, 0x000020, 0) == 0x200000);
}
