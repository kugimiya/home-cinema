#include <napi.h>

#include <nlohmann/json.hpp>

#include "session_manager.h"
#include "settings_json.h"

#include <memory>
#include <mutex>
#include <string>
#include <vector>

namespace {

using json = nlohmann::json;

std::unique_ptr<hc::TorrentSessionManager> g_session;
std::mutex g_sessionMutex;

hc::TorrentSessionManager& session() {
  if (!g_session) throw std::runtime_error("libtorrent session not initialized");
  return *g_session;
}

Napi::Value parseJsonString(Napi::Env env, const std::string& text) {
  Napi::Object json = env.Global().Get("JSON").As<Napi::Object>();
  Napi::Function parse = json.Get("parse").As<Napi::Function>();
  return parse.Call({Napi::String::New(env, text)});
}

Napi::Object jsonToObject(const nlohmann::json& j, Napi::Env env) {
  return parseJsonString(env, j.dump()).As<Napi::Object>();
}

class ReadRangeWorker : public Napi::AsyncWorker {
 public:
  ReadRangeWorker(Napi::Env env, Napi::Promise::Deferred deferred, std::string hash, int fileIndex,
                  int start, int end, double timeout)
      : Napi::AsyncWorker(env),
        deferred_(deferred),
        hash_(std::move(hash)),
        fileIndex_(fileIndex),
        start_(start),
        end_(end),
        timeout_(timeout) {}

  void Execute() override {
    try {
      data_ = session().readFileRange(hash_, fileIndex_, start_, end_, timeout_);
    } catch (const std::exception& e) {
      SetError(e.what());
    }
  }

  void OnOK() override {
    deferred_.Resolve(Napi::Buffer<std::uint8_t>::Copy(Env(), data_.data(), data_.size()));
  }

  void OnError(const Napi::Error& e) override { deferred_.Reject(e.Value()); }

 private:
  Napi::Promise::Deferred deferred_;
  std::string hash_;
  int fileIndex_;
  int start_;
  int end_;
  double timeout_;
  std::vector<std::uint8_t> data_;
};

Napi::Value InitSession(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsString() || !info[1].IsString()) {
    Napi::TypeError::New(env, "initSession(configJson, savePath)").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  try {
    std::lock_guard<std::mutex> lock(g_sessionMutex);
    auto cfg = hc::parseSessionConfigJson(info[0].As<Napi::String>().Utf8Value());
    g_session = std::make_unique<hc::TorrentSessionManager>(
        info[1].As<Napi::String>().Utf8Value(), std::move(cfg));
  } catch (const std::exception& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
  }
  return env.Undefined();
}

Napi::Value Ping(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Object o = Napi::Object::New(env);
  o.Set("status", "ok");
  return o;
}

Napi::Value DrainAlerts(const Napi::CallbackInfo& info) {
  int limit = 100;
  if (info.Length() >= 1 && info[0].IsNumber()) limit = info[0].As<Napi::Number>().Int32Value();
  auto alerts = session().drainAlerts(limit);
  nlohmann::json j = {{"alerts", alerts}};
  return jsonToObject(j, info.Env());
}

Napi::Value SessionStatus(const Napi::CallbackInfo& info) {
  return jsonToObject(session().sessionStatus(), info.Env());
}

Napi::Value AddTorrent(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::string link = info[0].As<Napi::String>().Utf8Value();
  std::string title = info[1].As<Napi::String>().Utf8Value();
  bool saveToDb = info.Length() < 3 || info[2].As<Napi::Boolean>().Value();
  return jsonToObject(session().addTorrent(link, title, saveToDb), env);
}

Napi::Value AddTorrentBytes(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  auto buf = info[0].As<Napi::Buffer<std::uint8_t>>();
  std::vector<std::uint8_t> data(buf.Data(), buf.Data() + buf.Length());
  std::string title = info[1].As<Napi::String>().Utf8Value();
  std::string magnet = info.Length() >= 3 ? info[2].As<Napi::String>().Utf8Value() : "";
  bool saveToDb = info.Length() < 4 || info[3].As<Napi::Boolean>().Value();
  return jsonToObject(session().addTorrentBytes(data, title, magnet, saveToDb), env);
}

Napi::Value ListTorrents(const Napi::CallbackInfo& info) {
  auto list = session().listTorrents();
  nlohmann::json j = list;
  return parseJsonString(info.Env(), j.dump());
}

Napi::Value GetTorrent(const Napi::CallbackInfo& info) {
  return jsonToObject(session().getTorrent(info[0].As<Napi::String>().Utf8Value()), info.Env());
}

Napi::Value RemoveTorrent(const Napi::CallbackInfo& info) {
  session().removeTorrent(info[0].As<Napi::String>().Utf8Value());
  return info.Env().Undefined();
}

Napi::Value SetScope(const Napi::CallbackInfo& info) {
  std::string hash = info[0].As<Napi::String>().Utf8Value();
  std::vector<int> ids;
  Napi::Array arr = info[1].As<Napi::Array>();
  for (uint32_t i = 0; i < arr.Length(); ++i) {
    ids.push_back(arr.Get(i).As<Napi::Number>().Int32Value());
  }
  session().setScope(hash, ids);
  return info.Env().Undefined();
}

Napi::Value SetMode(const Napi::CallbackInfo& info) {
  session().setMode(info[0].As<Napi::String>().Utf8Value(),
                    hc::parseMode(info[1].As<Napi::String>().Utf8Value()));
  return info.Env().Undefined();
}

Napi::Value Heartbeat(const Napi::CallbackInfo& info) {
  std::string hash = info[0].As<Napi::String>().Utf8Value();
  std::vector<int> ids;
  Napi::Array arr = info[1].As<Napi::Array>();
  for (uint32_t i = 0; i < arr.Length(); ++i) {
    ids.push_back(arr.Get(i).As<Napi::Number>().Int32Value());
  }
  bool active = info[2].As<Napi::Boolean>().Value();
  session().heartbeat(hash, ids, active);
  return info.Env().Undefined();
}

Napi::Value TickModes(const Napi::CallbackInfo& info) {
  session().tickModes();
  return info.Env().Undefined();
}

Napi::Value ReadFileRange(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  auto deferred = Napi::Promise::Deferred::New(env);
  std::string hash = info[0].As<Napi::String>().Utf8Value();
  int fileIndex = info[1].As<Napi::Number>().Int32Value();
  int start = info[2].As<Napi::Number>().Int32Value();
  int end = info[3].As<Napi::Number>().Int32Value();
  double timeout = info.Length() >= 5 ? info[4].As<Napi::Number>().DoubleValue() : 60.0;
  auto* worker = new ReadRangeWorker(env, deferred, hash, fileIndex, start, end, timeout);
  worker->Queue();
  return deferred.Promise();
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("initSession", Napi::Function::New(env, InitSession));
  exports.Set("ping", Napi::Function::New(env, Ping));
  exports.Set("drainAlerts", Napi::Function::New(env, DrainAlerts));
  exports.Set("sessionStatus", Napi::Function::New(env, SessionStatus));
  exports.Set("addTorrent", Napi::Function::New(env, AddTorrent));
  exports.Set("addTorrentBytes", Napi::Function::New(env, AddTorrentBytes));
  exports.Set("listTorrents", Napi::Function::New(env, ListTorrents));
  exports.Set("getTorrent", Napi::Function::New(env, GetTorrent));
  exports.Set("removeTorrent", Napi::Function::New(env, RemoveTorrent));
  exports.Set("setScope", Napi::Function::New(env, SetScope));
  exports.Set("setMode", Napi::Function::New(env, SetMode));
  exports.Set("heartbeat", Napi::Function::New(env, Heartbeat));
  exports.Set("tickModes", Napi::Function::New(env, TickModes));
  exports.Set("readFileRange", Napi::Function::New(env, ReadFileRange));
  return exports;
}

NODE_API_MODULE(lt_session, Init)

}  // namespace
