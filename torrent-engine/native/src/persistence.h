#pragma once

#include <map>
#include <string>
#include <tuple>
#include <vector>

namespace hc {

class TorrentIndex {
 public:
  explicit TorrentIndex(std::string savePath);

  void remember(const std::string& infoHash, const std::string& link, const std::string& title);
  void remove(const std::string& infoHash);
  std::vector<std::tuple<std::string, std::string, std::string>> allEntries() const;

 private:
  std::string dir_;
  std::string path_;
  std::map<std::string, std::pair<std::string, std::string>> entries_;

  void load();
  void save() const;
};

}  // namespace hc
