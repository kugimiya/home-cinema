# transcoder test plan

| ID | Case | Type | Priority |
|----|------|------|----------|
| TR-U01 | build_ffmpeg_command scale height 480 | unit | MVP |
| TR-U02 | build_ffmpeg_command copy vs transcode modes | unit | MVP |
| TR-A01 | GET /health 200 | api | MVP |
| TR-A02 | POST session missing file 404 | api | MVP |
| TR-I01 | sample video → index.m3u8 exists | integration | MVP |
| TR-I02 | height cap via ffprobe | integration | MVP |
| TR-I03 | max sessions 503 | integration | MVP |
