#pragma once

#include <deque>
#include <nlohmann/json.hpp>
#include <vector>

namespace hc {

class AlertRing {
 public:
  explicit AlertRing(std::size_t capacity);

  void extend(std::vector<nlohmann::json> alerts);
  std::vector<nlohmann::json> listRecent(int limit) const;
  std::size_t size() const { return items_.size(); }

 private:
  std::size_t capacity_;
  std::deque<nlohmann::json> items_;
};

}  // namespace hc
