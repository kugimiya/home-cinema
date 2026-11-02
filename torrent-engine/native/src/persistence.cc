#include "persistence.h"

#include <filesystem>
#include <fstream>
#include <map>
#include <nlohmann/json.hpp>

namespace fs = std::filesystem;
using json = nlohmann::json;

namespace hc {

TorrentIndex::TorrentIndex(std::string savePath) {
  dir_ = (fs::path(savePath) / ".engine").string();
  path_ = (fs::path(dir_) / "torrents.json").string();
  fs::create_directories(dir_);
  load();
}

void TorrentIndex::load() {
  entries_.clear();
  if (!fs::exists(path_)) return;
  try {
    std::ifstream in(path_);
    json raw;
    in >> raw;
    if (!raw.is_object()) return;
    for (auto it = raw.begin(); it != raw.end(); ++it) {
      const std::string h = it.key();
      std::string link;
      std::string title;
      if (it.value().is_object()) {
        link = it.value().value("link", "");
        title = it.value().value("title", h);
      }
      entries_[h] = {link, title};
    }
  } catch (...) {
    /* keep empty */
  }
}

void TorrentIndex::save() const {
  json raw = json::object();
  for (const auto& [h, meta] : entries_) {
    raw[h] = {{"link", meta.first}, {"title", meta.second}};
  }
  std::ofstream out(path_);
  out << raw.dump(2);
}

void TorrentIndex::remember(const std::string& infoHash, const std::string& link,
                            const std::string& title) {
  std::string h = infoHash;
  for (auto& c : h) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  entries_[h] = {link, title.empty() ? h : title};
  save();
}

void TorrentIndex::remove(const std::string& infoHash) {
  std::string h = infoHash;
  for (auto& c : h) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  if (entries_.erase(h)) save();
}

std::vector<std::tuple<std::string, std::string, std::string>> TorrentIndex::allEntries() const {
  std::vector<std::tuple<std::string, std::string, std::string>> out;
  for (const auto& [h, meta] : entries_) {
    out.emplace_back(h, meta.first, meta.second);
  }
  return out;
}

}  // namespace hc
