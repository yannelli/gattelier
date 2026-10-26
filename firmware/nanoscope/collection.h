#pragma once
#include <Arduino.h>
#include <cJSON.h>
#include "collection_rules.h"

class WebServer;
void startCollection(bool allowRun = true);
void updateCollection();
bool collectionEnabled();
CollectionScanPlan collectionScanPlan(uint32_t now);
void collectionToggle();
uint32_t collectionLedColor(uint32_t base, uint32_t now);
bool configureCollection(const cJSON* json, String& error);
cJSON* collectionState();
bool initializeCollectionStorage(String& error);
bool clearCollectionStorage(String& error);
void downloadCollection(WebServer& server);
void registerCollectionRoutes(WebServer& server);
