#pragma once

#include <libtorrent/settings_pack.hpp>

#include <nlohmann/json.hpp>
#include <string>

namespace hc {

struct SessionConfigParsed {
  libtorrent::settings_pack pack;
  int maxConnectionsPerTorrent = 100;
  int maxUploadSlotsPerTorrent = 4;
  int listenPort = 6881;
  nlohmann::json libtorrentSnapshot;
};

SessionConfigParsed parseSessionConfigJson(const std::string& configJson);

}  // namespace hc
