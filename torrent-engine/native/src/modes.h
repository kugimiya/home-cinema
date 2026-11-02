#pragma once

#include <set>
#include <string>

namespace hc {

constexpr int PRIORITY_OFF = 0;
constexpr int PRIORITY_BACKGROUND = 1;
constexpr int PRIORITY_STREAM = 7;

enum class TorrentMode { streaming, completing, seeding, paused };

TorrentMode parseMode(const std::string& value);
std::string modeToString(TorrentMode mode);

int fileDownloadPriority(int fileIndex, const std::set<int>& activeFileIndices);
std::set<int> applyModeToScope(TorrentMode mode, const std::set<int>& scopeFileIds);

}  // namespace hc
