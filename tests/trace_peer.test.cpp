#include "../firmware/nanoscope/trace_peer.h"
#include <cassert>

int main() {
  const TraceProvenance unknown;
  assert(!unknown.hasAddressType && !unknown.hasConnectionAttempt);
  const TraceProvenance advertisement(0);
  assert(advertisement.hasAddressType && advertisement.addressType == 0);
  assert(!advertisement.hasConnectionAttempt);
  const TraceProvenance zeroAttempt(0, 0);
  assert(zeroAttempt.hasAddressType && zeroAttempt.hasConnectionAttempt);
  assert(zeroAttempt.addressType == 0 && zeroAttempt.connectionAttempt == 0);
  TraceProvenance attemptOnly;
  attemptOnly.hasConnectionAttempt = true;
  assert(!attemptOnly.hasAddressType && attemptOnly.hasConnectionAttempt);

  char address[] = "AA:BB:CC:DD:EE:FF";
  TracePeer peer(address, 0, 41);
  address[0] = '0';
  assert(peer.matches("aa:bb:cc:dd:ee:ff", 0, 41));
  assert(!peer.matches(address, 0, 41));
  assert(!peer.matches(peer.address, 1, 41));
  assert(!peer.matches(peer.address, 0, 42));
  assert(!TracePeer{}.matches("", 0, 0));
  const TracePeer zeroPeer("AA:BB:CC:DD:EE:FF", 0, 0);
  assert(zeroPeer.matches(zeroPeer.address, 0, 0));

  TracePeer partial = zeroPeer;
  partial.provenance = advertisement;
  assert(!partial.matches(zeroPeer.address, 0, 0));
  partial.provenance = attemptOnly;
  assert(!partial.matches(zeroPeer.address, 0, 0));
  partial.provenance.hasAddressType = true;
  assert(partial.matches(zeroPeer.address, 0, 0));

  const TracePeer subscribedPeer = peer;
  peer = TracePeer("11:22:33:44:55:66", 1, 43);
  assert(subscribedPeer.matches("AA:BB:CC:DD:EE:FF", 0, 41));
  assert(!subscribedPeer.matches(peer.address, peer.provenance.addressType, peer.provenance.connectionAttempt));
  const TracePeer reconnected("AA:BB:CC:DD:EE:FF", 0, 42);
  assert(!subscribedPeer.matches(reconnected.address, reconnected.provenance.addressType, reconnected.provenance.connectionAttempt));
  assert(reconnected.matches(reconnected.address, 0, 42));
  const TracePeer otherType("AA:BB:CC:DD:EE:FF", 1, 41);
  assert(!subscribedPeer.matches(otherType.address, otherType.provenance.addressType, otherType.provenance.connectionAttempt));
}
