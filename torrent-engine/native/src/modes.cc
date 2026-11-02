#include "modes.h"

#include <stdexcept>

namespace hc {

TorrentMode parseMode(const std::string& value) {
  if (value == "streaming") return TorrentMode::streaming;
  if (value == "completing") return TorrentMode::completing;
  if (value == "seeding") return TorrentMode::seeding;
  if (value == "paused") return TorrentMode::paused;
  throw std::invalid_argument("unknown torrent mode: " + value);
}

std::string modeToString(TorrentMode mode) {
  switch (mode) {
    case TorrentMode::streaming:
      return "streaming";
    case TorrentMode::completing:
      return "completing";
    case TorrentMode::seeding:
      return "seeding";
    case TorrentMode::paused:
      return "paused";
  }
  return "completing";
}

int fileDownloadPriority(int fileIndex, const std::set<int>& activeFileIndices) {
  if (activeFileIndices.count(fileIndex)) return PRIORITY_STREAM;
  if (!activeFileIndices.empty()) return PRIORITY_BACKGROUND;
  return PRIORITY_OFF;
}

std::set<int> applyModeToScope(TorrentMode mode, const std::set<int>& scopeFileIds) {
  if (mode == TorrentMode::paused) return {};
  if (mode == TorrentMode::streaming || mode == TorrentMode::completing) return scopeFileIds;
  if (mode == TorrentMode::seeding) return {};
  return {};
}

}  // namespace hc
