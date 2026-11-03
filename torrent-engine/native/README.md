# libtorrent N-API addon (`lt_session.node`)

In-process **libtorrent** via Node-API (C++17). TypeScript loads the addon from `build/Release/lt_session.node`.

## Build

Requires **libtorrent-rasterbar-dev**, **pkg-config**, **build-essential**, and **node-gyp** (see root `package.json`).

```bash
# Debian/Ubuntu
sudo apt install libtorrent-rasterbar-dev pkg-config build-essential

cd torrent-engine
npm install   # runs node-gyp rebuild
npm run build # gyp + tsc
```

Docker multi-stage build downloads [nlohmann/json](https://github.com/nlohmann/json) header into `native/third_party/` during image build.

## Persistence (under `save_path/.engine/`)

| File | Purpose |
|------|---------|
| `torrents.json` | Index of added torrents (link + title) |
| `torrents/<hash>.torrent` | Cached metadata |
| `resume/<hash>.resume` | Fast-resume / piece state |
| `dht_state.benc` | libtorrent DHT routing table + node-id (restored on session start; refreshed ~every 60s and on shutdown) |

Bootstrap nodes from `TORRENT_ENGINE_DHT_BOOTSTRAP_NODES` remain configured as fallback; with a warm `dht_state.benc` the client rejoins the DHT from cached peers instead of cold bootstrap only.

## API

Called from [`src/native-binding.ts`](../src/native-binding.ts): `initSession(configJson, savePath)` then methods matching the former Python `lt_worker.py` RPC surface.

## Tests

Vitest uses a mock `SessionManager` (`tests/setup.ts`) so unit/HTTP tests do not require the native module. Integration: set `LT_INTEGRATION=1` and run inside the Docker build image.
