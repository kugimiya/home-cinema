#include "alert_ring.h"

namespace hc {

AlertRing::AlertRing(std::size_t capacity) : capacity_(capacity < 10 ? 10 : capacity) {}

void AlertRing::extend(std::vector<nlohmann::json> alerts) {
  for (auto& a : alerts) {
    if (items_.size() >= capacity_) items_.pop_front();
    items_.push_back(std::move(a));
  }
}

std::vector<nlohmann::json> AlertRing::listRecent(int limit) const {
  int lim = limit < 1 ? 1 : limit;
  if (static_cast<std::size_t>(lim) >= items_.size()) {
    return std::vector<nlohmann::json>(items_.begin(), items_.end());
  }
  return std::vector<nlohmann::json>(items_.end() - lim, items_.end());
}

}  // namespace hc
