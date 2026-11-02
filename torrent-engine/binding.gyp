{
  "targets": [
    {
      "target_name": "lt_session",
      "sources": [
        "native/src/addon.cc",
        "native/src/session_manager.cc",
        "native/src/persistence.cc",
        "native/src/settings_json.cc",
        "native/src/modes.cc",
        "native/src/alert_ring.cc"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include_dir\")",
        "native/src",
        "native/third_party"
      ],
      "dependencies": ["<!(node -p \"require('node-addon-api').gyp\")"],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"],
      "cflags!": ["-fno-exceptions"],
      "cflags_cc!": ["-fno-exceptions"],
      "cflags_cc": [
        "-std=c++17",
        "<!@(pkg-config --cflags libtorrent-rasterbar 2>/dev/null || pkg-config --cflags libtorrent-rasterbar2.0 2>/dev/null || echo '')"
      ],
      "libraries": [
        "<!@(pkg-config --libs libtorrent-rasterbar 2>/dev/null || pkg-config --libs libtorrent-rasterbar2.0 2>/dev/null || echo '-ltorrent-rasterbar')"
      ],
      "conditions": [
        [
          "OS=='linux'",
          {
            "libraries+": ["-lstdc++fs"]
          }
        ]
      ]
    }
  ]
}
