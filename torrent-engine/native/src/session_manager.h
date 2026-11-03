#pragma once

#include "alert_ring.h"
#include "modes.h"
#include "persistence.h"
#include "settings_json.h"

#include <libtorrent/session.hpp>
#include <libtorrent/torrent_handle.hpp>

#include <map>
#include <memory>
#include <mutex>
#include <nlohmann/json.hpp>
#include <set>
#include <string>
#include <vector>

namespace hc {

struct TorrentState {
  std::string title;
  std::string link;
  TorrentMode mode = TorrentMode::completing;
  std::set<int> scopeFileIds;
  double lastHeartbeat = 0;
};

class TorrentSessionManager {
 public:
  TorrentSessionManager(std::string savePath, SessionConfigParsed config);

  std::vector<nlohmann::json> drainAlerts(int limit);
  nlohmann::json sessionStatus();
  nlohmann::json addTorrent(const std::string& link, const std::string& title, bool saveToDb);
  nlohmann::json addTorrentBytes(const std::vector<std::uint8_t>& data, const std::string& title,
                                 const std::string& magnet, bool saveToDb);
  std::vector<nlohmann::json> listTorrents();
  nlohmann::json getTorrent(const std::string& infoHash);
  void removeTorrent(const std::string& infoHash);
  void setScope(const std::string& infoHash, const std::vector<int>& fileIds);
  void setMode(const std::string& infoHash, TorrentMode mode);
  void heartbeat(const std::string& infoHash, const std::vector<int>& fileIds, bool streamActive);
  void tickModes();
  std::vector<std::uint8_t> readFileRange(const std::string& infoHash, int fileIndex, int start,
                                          int end, double timeoutSec);

 private:
  std::string savePath_;
  SessionConfigParsed config_;
  TorrentIndex index_;
  AlertRing alertRing_;
  libtorrent::session session_;
  std::mutex lock_;
  std::map<std::string, TorrentState> states_;
  std::map<std::string, libtorrent::torrent_handle> handles_;

  int connectionsLimit_ = 500;
  int unchokeSlotsLimit_ = 20;
  nlohmann::json sessionSettingsSnapshot_;
  nlohmann::json clientIdentity_;

  void collectAlerts();
  void restorePersisted();
  libtorrent::torrent_handle* handleFor(const std::string& infoHash);
  std::string torrentFilePath(const std::string& infoHash) const;
  void saveTorrentFile(const std::string& infoHash, const std::vector<std::uint8_t>& data);
  libtorrent::add_torrent_params paramsFromBytes(const std::vector<std::uint8_t>& data);
  void applyTorrentConnectionLimits(libtorrent::torrent_handle& handle);
  void dropHandle(const std::string& infoHash);
  std::string addLinkUnlocked(const std::string& link, const std::string& title,
                              const std::string& infoHashHint = "");
  libtorrent::file_storage fileStorage(libtorrent::torrent_handle& handle);
  void applyPrioritiesUnlocked(const std::string& infoHash);
  void prioritizeByteRange(libtorrent::torrent_handle& handle, int fileIndex, int start, int end);
  std::pair<std::string, std::int64_t> resolveFilePath(const std::string& infoHash, int fileIndex);
  nlohmann::json detailUnlocked(const std::string& infoHash, TorrentState& st);
  std::vector<std::int64_t> fileProgressBytes(libtorrent::torrent_handle& handle, int numFiles);
  static std::string hashToHex(const libtorrent::sha1_hash& h);
  static std::string lower(std::string s);
  static nlohmann::json serializeAlert(const libtorrent::alert* a);
};

}  // namespace hc
