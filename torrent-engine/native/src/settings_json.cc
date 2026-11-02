#include "settings_json.h"

#include <libtorrent/settings_pack.hpp>

namespace hc {

namespace {

using json = nlohmann::json;

void setInt(libtorrent::settings_pack& pack, int name, const json& j, const char* key) {
  if (j.contains(key) && j[key].is_number_integer()) {
    pack.set_int(name, j[key].get<int>());
  }
}

void setBool(libtorrent::settings_pack& pack, int name, const json& j, const char* key) {
  if (j.contains(key) && j[key].is_boolean()) {
    pack.set_bool(name, j[key].get<bool>());
  }
}

void setStr(libtorrent::settings_pack& pack, int name, const json& j, const char* key) {
  if (j.contains(key) && j[key].is_string()) {
    pack.set_str(name, j[key].get<std::string>());
  }
}

}  // namespace

SessionConfigParsed parseSessionConfigJson(const std::string& configJson) {
  SessionConfigParsed out;
  json root = json::parse(configJson);
  json lt = root.contains("libtorrent") ? root["libtorrent"] : root;

  out.libtorrentSnapshot = lt;
  if (root.contains("max_connections_per_torrent")) {
    out.maxConnectionsPerTorrent = root["max_connections_per_torrent"].get<int>();
  }
  if (root.contains("max_upload_slots_per_torrent")) {
    out.maxUploadSlotsPerTorrent = root["max_upload_slots_per_torrent"].get<int>();
  }
  if (root.contains("listen_port")) {
    out.listenPort = root["listen_port"].get<int>();
  }

  libtorrent::settings_pack& pack = out.pack;
  setStr(pack, libtorrent::settings_pack::listen_interfaces, lt, "listen_interfaces");
  setBool(pack, libtorrent::settings_pack::enable_dht, lt, "enable_dht");
  setBool(pack, libtorrent::settings_pack::enable_lsd, lt, "enable_lsd");
  setBool(pack, libtorrent::settings_pack::enable_upnp, lt, "enable_upnp");
  setBool(pack, libtorrent::settings_pack::enable_natpmp, lt, "enable_natpmp");
  setInt(pack, libtorrent::settings_pack::connections_limit, lt, "connections_limit");
  setInt(pack, libtorrent::settings_pack::unchoke_slots_limit, lt, "unchoke_slots_limit");
  setInt(pack, libtorrent::settings_pack::connection_speed, lt, "connection_speed");
  setInt(pack, libtorrent::settings_pack::download_rate_limit, lt, "download_rate_limit");
  setInt(pack, libtorrent::settings_pack::upload_rate_limit, lt, "upload_rate_limit");
  setInt(pack, libtorrent::settings_pack::peer_turnover, lt, "peer_turnover");
  setInt(pack, libtorrent::settings_pack::peer_turnover_cutoff, lt, "peer_turnover_cutoff");
  setInt(pack, libtorrent::settings_pack::peer_turnover_interval, lt, "peer_turnover_interval");
  setInt(pack, libtorrent::settings_pack::max_out_request_queue, lt, "max_out_request_queue");
  setInt(pack, libtorrent::settings_pack::aio_threads, lt, "aio_threads");
  setInt(pack, libtorrent::settings_pack::hashing_threads, lt, "hashing_threads");
  setInt(pack, libtorrent::settings_pack::file_pool_size, lt, "file_pool_size");
  setInt(pack, libtorrent::settings_pack::checking_mem_usage, lt, "checking_mem_usage");
  setInt(pack, libtorrent::settings_pack::max_queued_disk_bytes, lt, "max_queued_disk_bytes");
  setBool(pack, libtorrent::settings_pack::piece_extent_affinity, lt, "piece_extent_affinity");
  setBool(pack, libtorrent::settings_pack::anonymous_mode, lt, "anonymous_mode");
  setInt(pack, libtorrent::settings_pack::send_buffer_watermark, lt, "send_buffer_watermark");
  setInt(pack, libtorrent::settings_pack::send_buffer_low_watermark, lt, "send_buffer_low_watermark");
  setInt(pack, libtorrent::settings_pack::send_buffer_watermark_factor, lt,
         "send_buffer_watermark_factor");
  setInt(pack, libtorrent::settings_pack::upnp_lease_duration, lt, "upnp_lease_duration");
  setInt(pack, libtorrent::settings_pack::peer_dscp, lt, "peer_dscp");
  setBool(pack, libtorrent::settings_pack::rate_limit_ip_overhead, lt, "rate_limit_ip_overhead");
  setInt(pack, libtorrent::settings_pack::max_concurrent_http_announces, lt,
         "max_concurrent_http_announces");
  setInt(pack, libtorrent::settings_pack::stop_tracker_timeout, lt, "stop_tracker_timeout");
  setInt(pack, libtorrent::settings_pack::resolver_cache_timeout, lt, "resolver_cache_timeout");
  setBool(pack, libtorrent::settings_pack::allow_idna, lt, "allow_idna");
  setBool(pack, libtorrent::settings_pack::allow_multiple_connections_per_ip, lt,
          "allow_multiple_connections_per_ip");
  setBool(pack, libtorrent::settings_pack::validate_https_trackers, lt, "validate_https_trackers");
  setBool(pack, libtorrent::settings_pack::ssrf_mitigation, lt, "ssrf_mitigation");
  setBool(pack, libtorrent::settings_pack::no_connect_privileged_ports, lt,
          "no_connect_privileged_ports");
  setBool(pack, libtorrent::settings_pack::apply_ip_filter_to_trackers, lt,
          "apply_ip_filter_to_trackers");
  setStr(pack, libtorrent::settings_pack::dht_bootstrap_nodes, lt, "dht_bootstrap_nodes");
  setInt(pack, libtorrent::settings_pack::out_enc_policy, lt, "out_enc_policy");
  setInt(pack, libtorrent::settings_pack::in_enc_policy, lt, "in_enc_policy");
  setInt(pack, libtorrent::settings_pack::active_downloads, lt, "active_downloads");
  setInt(pack, libtorrent::settings_pack::active_seeds, lt, "active_seeds");
  setInt(pack, libtorrent::settings_pack::active_limit, lt, "active_limit");
  setBool(pack, libtorrent::settings_pack::dont_count_slow_torrents, lt, "dont_count_slow_torrents");
  setInt(pack, libtorrent::settings_pack::inactive_down_rate, lt, "inactive_down_rate");
  setInt(pack, libtorrent::settings_pack::inactive_up_rate, lt, "inactive_up_rate");
  setInt(pack, libtorrent::settings_pack::auto_manage_startup, lt, "auto_manage_startup");
  setBool(pack, libtorrent::settings_pack::enable_incoming_tcp, lt, "enable_incoming_tcp");
  setBool(pack, libtorrent::settings_pack::enable_outgoing_tcp, lt, "enable_outgoing_tcp");
  setBool(pack, libtorrent::settings_pack::enable_incoming_utp, lt, "enable_incoming_utp");
  setBool(pack, libtorrent::settings_pack::enable_outgoing_utp, lt, "enable_outgoing_utp");
  setInt(pack, libtorrent::settings_pack::mixed_mode_algorithm, lt, "mixed_mode_algorithm");
  setInt(pack, libtorrent::settings_pack::choking_algorithm, lt, "choking_algorithm");
  setInt(pack, libtorrent::settings_pack::seed_choking_algorithm, lt, "seed_choking_algorithm");
  setInt(pack, libtorrent::settings_pack::disk_io_read_mode, lt, "disk_io_read_mode");
  setInt(pack, libtorrent::settings_pack::disk_io_write_mode, lt, "disk_io_write_mode");
  setInt(pack, libtorrent::settings_pack::suggest_mode, lt, "suggest_mode");
  setStr(pack, libtorrent::settings_pack::user_agent, lt, "user_agent");
  setStr(pack, libtorrent::settings_pack::peer_fingerprint, lt, "peer_fingerprint");
  setStr(pack, libtorrent::settings_pack::handshake_client_version, lt, "handshake_client_version");
  setInt(pack, libtorrent::settings_pack::send_socket_buffer_size, lt, "send_socket_buffer_size");
  setInt(pack, libtorrent::settings_pack::recv_socket_buffer_size, lt, "recv_socket_buffer_size");
  setInt(pack, libtorrent::settings_pack::listen_queue_size, lt, "listen_queue_size");
  setInt(pack, libtorrent::settings_pack::allowed_enc_level, lt, "allowed_enc_level");
  setBool(pack, libtorrent::settings_pack::prefer_rc4, lt, "prefer_rc4");
  setInt(pack, libtorrent::settings_pack::active_checking, lt, "active_checking");
  setBool(pack, libtorrent::settings_pack::announce_to_all_trackers, lt, "announce_to_all_trackers");
  setBool(pack, libtorrent::settings_pack::announce_to_all_tiers, lt, "announce_to_all_tiers");
  setInt(pack, libtorrent::settings_pack::active_tracker_limit, lt, "active_tracker_limit");
  setInt(pack, libtorrent::settings_pack::active_dht_limit, lt, "active_dht_limit");
  setInt(pack, libtorrent::settings_pack::active_lsd_limit, lt, "active_lsd_limit");

  if (lt.contains("outgoing_port") && lt.contains("num_outgoing_ports")) {
    setInt(pack, libtorrent::settings_pack::outgoing_port, lt, "outgoing_port");
    setInt(pack, libtorrent::settings_pack::num_outgoing_ports, lt, "num_outgoing_ports");
  }

  return out;
}

}  // namespace hc
