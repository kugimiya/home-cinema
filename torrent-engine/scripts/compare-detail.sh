#!/usr/bin/env bash
# Compare torrent detail JSON keys from Python reference (if app/ restored) vs native.
# Usage: run inside torrent-engine Docker build env with a fixture magnet/torrent.
set -euo pipefail
echo "Golden compare: manual step — load same .torrent in Python session.py vs native getTorrent and diff keys."
echo "See native/README.md integration notes."
