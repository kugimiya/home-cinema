#include "session_manager.h"

#include <libtorrent/add_torrent_params.hpp>
#include <libtorrent/alert_types.hpp>
#include <libtorrent/load_torrent.hpp>
#include <libtorrent/magnet_uri.hpp>
#include <libtorrent/read_resume_data.hpp>
#include <libtorrent/span.hpp>
#include <libtorrent/torrent_info.hpp>
#include <libtorrent/torrent_status.hpp>

#include <chrono>
#include <cctype>
#include <filesystem>
#include <fstream>
#include <optional>
#include <regex>
#include <sstream>
#include <thread>

namespace fs = std::filesystem;
using json = nlohmann::json;
namespace lt = libtorrent;

namespace hc {

namespace {

constexpr int kMaxPieceScan = 8000;

void configureAlertMask(lt::session& ses) {
  ses.set_alert_mask(lt::alert::all_categories);
}

void applyAddTorrentFlags(lt::add_torrent_params& params) {
  params.flags |= lt::torrent_flags::sequential_download;
  params.flags |= lt::torrent_flags::no_verify_files;
}

void enableSequentialDownload(lt::add_torrent_params* params, lt::torrent_handle* handle) {
  if (params) applyAddTorrentFlags(*params);
  if (handle && handle->is_valid()) {
    handle->set_sequential_download(true);
  }
}

std::optional<std::string> infoHashFromMagnet(const std::string& link) {
  static const std::regex hexRe(R"(btih:([a-fA-F0-9]{40}))", std::regex::icase);
  std::smatch m;
  if (std::regex_search(link, m, hexRe)) {
    std::string h = m[1].str();
    for (auto& c : h) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    return h;
  }
  return std::nullopt;
}

double nowSec() {
  return std::chrono::duration<double>(
             std::chrono::system_clock::now().time_since_epoch())
      .count();
}

json jsonFieldOrNull(const json& obj, const char* key) {
  if (obj.contains(key) && !obj[key].is_null()) return obj[key];
  return nullptr;
}

}  // namespace

std::string TorrentSessionManager::lower(std::string s) {
  for (auto& c : s) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  return s;
}

std::string TorrentSessionManager::hashToHex(const lt::sha1_hash& h) {
  std::ostringstream oss;
  oss << h;
  std::string out = oss.str();
  for (auto& c : out) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  return out;
}

TorrentSessionManager::TorrentSessionManager(std::string savePath, SessionConfigParsed config)
    : savePath_(std::move(savePath)),
      config_(std::move(config)),
      index_(savePath_),
      alertRing_(400),
      session_(config_.pack) {
  fs::create_directories(savePath_);
  configureAlertMask(session_);

  connectionsLimit_ = config_.libtorrentSnapshot.value("connections_limit", 500);
  unchokeSlotsLimit_ = config_.libtorrentSnapshot.value("unchoke_slots_limit", 20);

  sessionSettingsSnapshot_ = {
      {"enable_dht", config_.libtorrentSnapshot.value("enable_dht", true)},
      {"enable_lsd", config_.libtorrentSnapshot.value("enable_lsd", true)},
      {"enable_upnp", config_.libtorrentSnapshot.value("enable_upnp", true)},
      {"enable_natpmp", config_.libtorrentSnapshot.value("enable_natpmp", true)},
      {"unchoke_slots_limit", unchokeSlotsLimit_},
      {"max_connections_per_torrent", config_.maxConnectionsPerTorrent},
      {"max_upload_slots_per_torrent", config_.maxUploadSlotsPerTorrent},
      {"download_rate_limit", config_.libtorrentSnapshot.value("download_rate_limit", 0)},
      {"upload_rate_limit", config_.libtorrentSnapshot.value("upload_rate_limit", 0)},
      {"connection_speed", config_.libtorrentSnapshot.value("connection_speed", 30)},
      {"peer_turnover", config_.libtorrentSnapshot.value("peer_turnover", 4)},
  };

  clientIdentity_ = json::object();
  for (const char* key : {"user_agent", "peer_fingerprint", "handshake_client_version"}) {
    if (config_.libtorrentSnapshot.contains(key)) {
      clientIdentity_[key] = config_.libtorrentSnapshot[key];
    }
  }

  restorePersisted();
}

json TorrentSessionManager::serializeAlert(const lt::alert* a) {
  json out = {{"type", "alert"}, {"at", nowSec()}, {"message", a->message()}};
  if (auto* ta = lt::alert_cast<lt::torrent_alert>(a)) {
    if (ta->handle.is_valid()) {
      out["info_hash"] = hashToHex(ta->handle.info_hashes().get_best());
    }
  }
  return out;
}

void TorrentSessionManager::collectAlerts() {
  std::vector<lt::alert*> alerts;
  session_.pop_alerts(&alerts);
  if (alerts.empty()) return;
  std::vector<json> batch;
  batch.reserve(alerts.size());
  for (auto* a : alerts) batch.push_back(serializeAlert(a));
  alertRing_.extend(std::move(batch));
}

std::vector<json> TorrentSessionManager::drainAlerts(int limit) {
  collectAlerts();
  return alertRing_.listRecent(limit);
}

json TorrentSessionManager::sessionStatus() {
  collectAlerts();
  double now = nowSec();
  std::lock_guard<std::mutex> guard(lock_);
  int totalDl = 0, totalUl = 0, activeDl = 0, waitingMeta = 0, seeding = 0;
  for (auto& [_, h] : handles_) {
    if (!h.is_valid()) continue;
    lt::torrent_status st = h.status();
    totalDl += static_cast<int>(st.download_rate);
    totalUl += static_cast<int>(st.upload_rate);
    if (st.download_rate > 0) activeDl++;
    if (!st.has_metadata) waitingMeta++;
    if (st.is_seeding) seeding++;
  }
  json out = sessionSettingsSnapshot_;
  out["save_path"] = savePath_;
  out["connections_limit"] = connectionsLimit_;
  out["listen"] = "0.0.0.0:" + std::to_string(config_.listenPort);
  out["torrent_count"] = handles_.size();
  out["download_rate"] = totalDl;
  out["upload_rate"] = totalUl;
  out["active_downloads"] = activeDl;
  out["waiting_metadata"] = waitingMeta;
  out["seeding_count"] = seeding;
  out["alert_buffer_size"] = alertRing_.size();
  out["user_agent"] = jsonFieldOrNull(clientIdentity_, "user_agent");
  out["peer_fingerprint"] = jsonFieldOrNull(clientIdentity_, "peer_fingerprint");
  out["handshake_client_version"] = jsonFieldOrNull(clientIdentity_, "handshake_client_version");
  std::string dht;
  if (config_.libtorrentSnapshot.contains("dht_bootstrap_nodes") &&
      config_.libtorrentSnapshot["dht_bootstrap_nodes"].is_string()) {
    dht = config_.libtorrentSnapshot["dht_bootstrap_nodes"].get<std::string>();
  }
  out["dht_bootstrap_nodes"] = dht.empty() ? json(nullptr) : json(dht);
  out["collected_at"] = now;
  return out;
}

lt::torrent_handle* TorrentSessionManager::handleFor(const std::string& infoHash) {
  auto it = handles_.find(lower(infoHash));
  if (it == handles_.end() || !it->second.is_valid()) return nullptr;
  return &it->second;
}

std::string TorrentSessionManager::torrentFilePath(const std::string& infoHash) const {
  return (fs::path(savePath_) / ".engine" / "torrents" / (lower(infoHash) + ".torrent")).string();
}

void TorrentSessionManager::saveTorrentFile(const std::string& infoHash,
                                            const std::vector<std::uint8_t>& data) {
  fs::path path = torrentFilePath(infoHash);
  fs::create_directories(path.parent_path());
  std::ofstream out(path, std::ios::binary);
  out.write(reinterpret_cast<const char*>(data.data()),
            static_cast<std::streamsize>(data.size()));
}

lt::add_torrent_params TorrentSessionManager::paramsFromBytes(const std::vector<std::uint8_t>& data) {
  lt::span<const char> buf(reinterpret_cast<const char*>(data.data()), data.size());
  lt::add_torrent_params params = lt::load_torrent_buffer(buf);
  params.save_path = savePath_;
  applyAddTorrentFlags(params);
  return params;
}

void TorrentSessionManager::applyTorrentConnectionLimits(lt::torrent_handle& handle) {
  if (!handle.is_valid()) return;
  handle.set_max_connections(config_.maxConnectionsPerTorrent);
  handle.set_max_uploads(config_.maxUploadSlotsPerTorrent);
}

void TorrentSessionManager::dropHandle(const std::string& infoHash) {
  std::string h = lower(infoHash);
  auto it = handles_.find(h);
  if (it != handles_.end() && it->second.is_valid()) {
    session_.remove_torrent(it->second);
  }
  handles_.erase(h);
  states_.erase(h);
}

std::string TorrentSessionManager::addLinkUnlocked(const std::string& link, const std::string& title,
                                                   const std::string& infoHashHint) {
  std::string stripped = link;
  while (!stripped.empty() && (stripped.back() == ' ' || stripped.back() == '\t')) stripped.pop_back();
  size_t start = stripped.find_first_not_of(" \t");
  if (start != std::string::npos) stripped = stripped.substr(start);

  lt::add_torrent_params params;
  lt::error_code ec;
  if (stripped.rfind("magnet:", 0) == 0) {
    params = lt::parse_magnet_uri(stripped, ec);
    if (ec) throw std::runtime_error(ec.message());
  } else {
    if (!fs::is_regular_file(stripped)) {
      throw std::runtime_error("Torrent file not found: " + stripped);
    }
    std::ifstream in(stripped, std::ios::binary);
    std::vector<std::uint8_t> buf((std::istreambuf_iterator<char>(in)), {});
    params = paramsFromBytes(buf);
  }
  params.save_path = savePath_;
  applyAddTorrentFlags(params);
  lt::torrent_handle handle = session_.add_torrent(params);
  enableSequentialDownload(nullptr, &handle);
  applyTorrentConnectionLimits(handle);

  std::string ih = infoHashHint;
  if (ih.empty()) ih = hashToHex(handle.info_hashes().get_best());
  std::string h = lower(ih);
  handles_[h] = handle;
  if (states_.find(h) == states_.end()) {
    states_[h] = TorrentState{title, link, TorrentMode::completing, {}, nowSec()};
  }
  index_.remember(h, link, title);
  applyPrioritiesUnlocked(h);
  return h;
}

void TorrentSessionManager::restorePersisted() {
  for (const auto& [infoHash, link, title] : index_.allEntries()) {
    if (link.empty()) continue;
    try {
      std::string restoreLink = link;
      if (fs::is_regular_file(torrentFilePath(infoHash))) restoreLink = torrentFilePath(infoHash);
      addLinkUnlocked(restoreLink, title, infoHash);
      auto& st = states_[lower(infoHash)];
      st.title = title;
      st.link = link;
      st.mode = TorrentMode::completing;
      if (auto* h = handleFor(infoHash)) {
        if (h->status().is_seeding) st.mode = TorrentMode::seeding;
      }
      applyPrioritiesUnlocked(lower(infoHash));
    } catch (...) {
      /* skip failed restore */
    }
  }
}

json TorrentSessionManager::addTorrentBytes(const std::vector<std::uint8_t>& data,
                                            const std::string& title, const std::string& magnet,
                                            bool saveToDb) {
  std::lock_guard<std::mutex> guard(lock_);
  lt::add_torrent_params params = paramsFromBytes(data);
  std::string h = lower(hashToHex(params.info_hashes.get_best()));

  if (auto* existing = handleFor(h)) {
    if (existing->status().has_metadata) {
      return detailUnlocked(h, states_[h]);
    }
    dropHandle(h);
  }

  enableSequentialDownload(&params, nullptr);
  lt::torrent_handle handle = session_.add_torrent(params);
  enableSequentialDownload(nullptr, &handle);
  applyTorrentConnectionLimits(handle);
  handles_[h] = handle;
  saveTorrentFile(h, data);
  std::string link = magnet.empty() ? torrentFilePath(h) : magnet;
  states_[h] = TorrentState{title, link, TorrentMode::completing, {}, nowSec()};
  if (saveToDb) index_.remember(h, link, title);
  applyPrioritiesUnlocked(h);
  return detailUnlocked(h, states_[h]);
}

json TorrentSessionManager::addTorrent(const std::string& link, const std::string& title,
                                         bool saveToDb) {
  std::lock_guard<std::mutex> guard(lock_);
  if (link.rfind("magnet:", 0) == 0) {
    if (auto ih = infoHashFromMagnet(link)) {
      if (handles_.count(*ih)) {
        return detailUnlocked(*ih, states_[*ih]);
      }
    }
  }
  std::string h = addLinkUnlocked(link, title);
  if (saveToDb) index_.remember(h, link, title);
  return detailUnlocked(h, states_[h]);
}

lt::file_storage TorrentSessionManager::fileStorage(lt::torrent_handle& handle) {
  std::shared_ptr<const lt::torrent_info> ti = handle.torrent_file();
  if (!ti) throw std::runtime_error("No metadata yet");
  return ti->files();
}

void TorrentSessionManager::applyPrioritiesUnlocked(const std::string& infoHash) {
  lt::torrent_handle* handle = handleFor(infoHash);
  if (!handle || !handle->status().has_metadata) return;
  enableSequentialDownload(nullptr, handle);
  TorrentState* st = &states_[lower(infoHash)];
  std::set<int> active = applyModeToScope(st->mode, st->scopeFileIds);
  lt::file_storage fs = fileStorage(*handle);

  if (st->mode == TorrentMode::seeding) {
    for (int idx = 0; idx < fs.num_files(); ++idx) handle->file_priority(idx, 7);
    handle->set_upload_mode(false);
  } else if (st->mode == TorrentMode::completing && active.empty()) {
    for (int idx = 0; idx < fs.num_files(); ++idx) handle->file_priority(idx, 1);
  } else {
    for (int idx = 0; idx < fs.num_files(); ++idx) {
      int fileIdx = idx + 1;
      int pri = fileDownloadPriority(fileIdx, active);
      int ltPri = pri == PRIORITY_OFF ? 0 : (pri == PRIORITY_BACKGROUND ? 1 : 7);
      handle->file_priority(idx, ltPri);
    }
  }
  if (st->mode == TorrentMode::paused) {
    handle->pause();
  } else {
    handle->resume();
  }
}

void TorrentSessionManager::setScope(const std::string& infoHash, const std::vector<int>& fileIds) {
  std::string h = lower(infoHash);
  std::lock_guard<std::mutex> guard(lock_);
  TorrentState& st = states_[h];
  if (st.title.empty()) st.title = h;
  st.scopeFileIds.clear();
  for (int id : fileIds) {
    if (id > 0) st.scopeFileIds.insert(id);
  }
  if (st.mode == TorrentMode::paused) st.mode = TorrentMode::streaming;
  applyPrioritiesUnlocked(h);
}

void TorrentSessionManager::setMode(const std::string& infoHash, TorrentMode mode) {
  std::string h = lower(infoHash);
  std::lock_guard<std::mutex> guard(lock_);
  TorrentState& st = states_[h];
  if (st.title.empty()) st.title = h;
  st.mode = mode;
  if (mode == TorrentMode::completing && st.scopeFileIds.empty()) {
    if (auto* handle = handleFor(h)) {
      if (handle->status().has_metadata) {
        lt::file_storage fs = fileStorage(*handle);
        if (fs.num_files() == 1) st.scopeFileIds.insert(1);
      }
    }
  }
  applyPrioritiesUnlocked(h);
}

void TorrentSessionManager::heartbeat(const std::string& infoHash, const std::vector<int>& fileIds,
                                      bool streamActive) {
  std::string h = lower(infoHash);
  std::lock_guard<std::mutex> guard(lock_);
  TorrentState& st = states_[h];
  if (st.title.empty()) st.title = h;
  st.lastHeartbeat = nowSec();
  if (!fileIds.empty()) {
    st.scopeFileIds.clear();
    for (int id : fileIds) {
      if (id > 0) st.scopeFileIds.insert(id);
    }
  }
  if (streamActive) st.mode = TorrentMode::streaming;
  applyPrioritiesUnlocked(h);
}

void TorrentSessionManager::tickModes() {
  collectAlerts();
  std::lock_guard<std::mutex> guard(lock_);
  for (auto& [h, st] : states_) {
    lt::torrent_handle* handle = handleFor(h);
    if (!handle) continue;
    if (handle->status().is_seeding && st.mode == TorrentMode::completing) {
      st.mode = TorrentMode::seeding;
      applyPrioritiesUnlocked(h);
    }
  }
}

void TorrentSessionManager::removeTorrent(const std::string& infoHash) {
  std::string h = lower(infoHash);
  {
    std::lock_guard<std::mutex> guard(lock_);
    lt::torrent_handle* handle = handleFor(h);
    if (handle) {
      session_.remove_torrent(*handle, lt::session::delete_files);
    }
    handles_.erase(h);
    states_.erase(h);
    index_.remove(h);
  }
  fs::path torrentDir = fs::path(savePath_) / h;
  if (fs::is_directory(torrentDir)) {
    std::error_code ec;
    fs::remove_all(torrentDir, ec);
  }
}

std::vector<double> TorrentSessionManager::fileProgressFractions(lt::torrent_handle& handle,
                                                                 int numFiles) {
  std::vector<double> out(numFiles, 0.0);
  try {
    std::vector<std::int64_t> fp = handle.file_progress(lt::torrent_handle::piece_granularity);
    for (int i = 0; i < numFiles && i < static_cast<int>(fp.size()); ++i) {
      out[i] = static_cast<double>(fp[static_cast<std::size_t>(i)]) / 1000.0;
    }
  } catch (...) {
  }
  return out;
}

json TorrentSessionManager::detailUnlocked(const std::string& infoHash, TorrentState& st) {
  lt::torrent_handle* handle = handleFor(infoHash);
  if (!handle) return json::object();
  lt::torrent_status status = handle->status();
  json files = json::array();
  std::int64_t torrentSize = 0;
  std::int64_t loadedSize = 0;

  if (status.has_metadata) {
    lt::file_storage fs = fileStorage(*handle);
    std::vector<double> progress = fileProgressFractions(*handle, fs.num_files());
    std::set<int> active = applyModeToScope(st.mode, st.scopeFileIds);
    bool completingAll = st.mode == TorrentMode::completing && active.empty();
    for (int idx = 0; idx < fs.num_files(); ++idx) {
      int fileIdx = idx + 1;
      std::int64_t length = fs.file_size(idx);
      torrentSize += length;
      double frac = idx < static_cast<int>(progress.size()) ? progress[idx] : 0.0;
      if (frac > 1.0) frac = 1.0;
      std::int64_t downloaded = static_cast<std::int64_t>(frac * length);
      if (downloaded > length) downloaded = length;
      loadedSize += downloaded;
      int pri = st.mode == TorrentMode::seeding
                    ? PRIORITY_STREAM
                    : (completingAll ? PRIORITY_BACKGROUND
                                     : fileDownloadPriority(fileIdx, active));
      files.push_back({{"id", fileIdx},
                       {"path", fs.file_path(idx)},
                       {"length", length},
                       {"downloaded_bytes", downloaded},
                       {"completed", length > 0 && downloaded >= static_cast<std::int64_t>(length * 0.995)},
                       {"priority", pri}});
    }
  }

  if (status.total_wanted > 0) torrentSize = status.total_wanted;
  if (status.total_done > 0) loadedSize = status.total_done;

  int numSeeds = 0;
  numSeeds = status.num_seeds;

  double progress = status.progress;
  int numConnections = status.num_peers;
  std::int64_t allTimeDownload = status.all_time_download;

  std::string errorMsg;
  if (status.errc) errorMsg = status.errc.message();

  bool isPaused = status.flags & lt::torrent_flags::paused;
  int piecesTotal = 0;
  int piecesHave = 0;
  int pieceLength = 0;
  if (status.has_metadata) {
    auto ti = handle->torrent_file();
    if (ti) {
      piecesTotal = ti->num_pieces();
      pieceLength = ti->piece_length();
      if (piecesTotal <= kMaxPieceScan) {
        for (int i = 0; i < piecesTotal; ++i) {
          if (handle->have_piece(i)) piecesHave++;
        }
      } else if (piecesTotal > 0) {
        piecesHave = static_cast<int>(progress * piecesTotal);
      }
    }
  }

  std::vector<int> scopeSorted(st.scopeFileIds.begin(), st.scopeFileIds.end());
  std::sort(scopeSorted.begin(), scopeSorted.end());

  std::string statString = "unknown";
  switch (status.state) {
    case lt::torrent_status::checking_files:
      statString = "checking_files";
      break;
    case lt::torrent_status::downloading_metadata:
      statString = "downloading_metadata";
      break;
    case lt::torrent_status::downloading:
      statString = "downloading";
      break;
    case lt::torrent_status::finished:
      statString = "finished";
      break;
    case lt::torrent_status::seeding:
      statString = "seeding";
      break;
    case lt::torrent_status::checking_resume_data:
      statString = "checking_resume_data";
      break;
    default:
      statString = "unknown";
      break;
  }

  double hbAge = std::max(0.0, nowSec() - st.lastHeartbeat);

  return json{
      {"hash", lower(infoHash)},
      {"title", st.title},
      {"stat_string", statString},
      {"torrent_size", torrentSize},
      {"loaded_size", loadedSize},
      {"download_speed", status.download_rate},
      {"upload_speed", status.upload_rate},
      {"total_peers", status.num_peers},
      {"bytes_written_data", status.all_time_upload},
      {"connected_seeders", numSeeds},
      {"mode", modeToString(st.mode)},
      {"file_stats", files},
      {"has_metadata", status.has_metadata},
      {"is_seeding", status.is_seeding},
      {"is_finished", status.is_finished},
      {"is_paused", isPaused},
      {"progress", progress},
      {"num_connections", numConnections},
      {"all_time_download", allTimeDownload},
      {"error", errorMsg.empty() ? json(nullptr) : json(errorMsg)},
      {"save_path", handle->save_path()},
      {"torrent_name", handle->name()},
      {"scope_file_ids", scopeSorted},
      {"last_heartbeat_age_sec", std::round(hbAge * 10.0) / 10.0},
      {"sequential_download", true},
      {"pieces_total", piecesTotal ? json(piecesTotal) : json(nullptr)},
      {"pieces_have", piecesHave ? json(piecesHave) : json(nullptr)},
      {"piece_length", pieceLength ? json(pieceLength) : json(nullptr)},
  };
}

std::vector<json> TorrentSessionManager::listTorrents() {
  std::lock_guard<std::mutex> guard(lock_);
  std::vector<json> out;
  for (auto& [h, st] : states_) {
    json d = detailUnlocked(h, st);
    if (!d.empty()) out.push_back(std::move(d));
  }
  return out;
}

json TorrentSessionManager::getTorrent(const std::string& infoHash) {
  std::lock_guard<std::mutex> guard(lock_);
  std::string h = lower(infoHash);
  auto it = states_.find(h);
  if (it == states_.end()) return json::object();
  return detailUnlocked(h, it->second);
}

void TorrentSessionManager::prioritizeByteRange(lt::torrent_handle& handle, int fileIndex, int start,
                                              int end) {
  if (!handle.status().has_metadata) return;
  auto ti = handle.torrent_file();
  if (!ti) return;
  lt::file_storage fs = ti->files();
  int idx = fileIndex - 1;
  std::int64_t fileOffset = fs.file_offset(idx);
  int pieceLength = ti->piece_length();
  int firstPiece = static_cast<int>((fileOffset + start) / pieceLength);
  int lastPiece = static_cast<int>((fileOffset + end) / pieceLength);
  int msPerPiece = std::max(1, pieceLength / 1024);
  for (int i = 0, p = firstPiece; p <= lastPiece; ++p, ++i) {
    handle.piece_priority(p, 7);
    handle.set_piece_deadline(p, i * msPerPiece);
  }
}

std::pair<std::string, std::int64_t> TorrentSessionManager::resolveFilePath(const std::string& infoHash,
                                                                          int fileIndex) {
  lt::torrent_handle* handle = handleFor(infoHash);
  if (!handle || !handle->status().has_metadata) {
    throw std::runtime_error("Torrent or metadata missing");
  }
  lt::file_storage fs = fileStorage(*handle);
  int idx = fileIndex - 1;
  if (idx < 0 || idx >= fs.num_files()) throw std::runtime_error("File index out of range");
  std::string rel = fs.file_path(idx);
  std::int64_t length = fs.file_size(idx);
  fs::path path = fs::path(handle->save_path()) / handle->name() / rel;
  if (!fs::is_regular_file(path)) {
    fs::path alt = fs::path(savePath_) / lower(infoHash) / rel;
    if (fs::is_regular_file(alt)) path = alt;
  }
  return {path.string(), length};
}

std::vector<std::uint8_t> TorrentSessionManager::readFileRange(const std::string& infoHash,
                                                               int fileIndex, int start, int end,
                                                               double timeoutSec) {
  double deadline = nowSec() + timeoutSec;
  while (nowSec() < deadline) {
    lt::torrent_status status;
    fs::path path;
    std::int64_t length = 0;
    int endClamped = end;
    {
      std::lock_guard<std::mutex> guard(lock_);
      lt::torrent_handle* handle = handleFor(infoHash);
      if (!handle) throw std::runtime_error("Torrent missing");
      auto resolved = resolveFilePath(infoHash, fileIndex);
      path = resolved.first;
      length = resolved.second;
      endClamped = static_cast<int>(std::min<std::int64_t>(end, length - 1));
      if (length && start >= length) return {};
      prioritizeByteRange(*handle, fileIndex, start, endClamped);
      status = handle->status();
    }
    if (fs::is_regular_file(path)) {
      std::int64_t size = fs::file_size(path);
      if (size > start) {
        std::ifstream in(path, std::ios::binary);
        in.seekg(start);
        std::size_t want = static_cast<std::size_t>(endClamped - start + 1);
        std::vector<std::uint8_t> data(want);
        in.read(reinterpret_cast<char*>(data.data()), static_cast<std::streamsize>(want));
        data.resize(static_cast<std::size_t>(in.gcount()));
        if (data.size() >= want || status.is_seeding) return data;
      }
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(250));
  }
  throw std::runtime_error("Timed out waiting for torrent pieces");
}

}  // namespace hc
