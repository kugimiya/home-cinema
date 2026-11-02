# torrent-engine test plan

| ID | Case | Type | Priority |
|----|------|------|----------|
| TE-U01 | file_download_priority stream/background/off | unit | MVP |
| TE-U02 | mode transitions streaming→completing→seeding | unit | MVP |
| TE-U03 | info_hash_from_magnet hex/base32 | unit | MVP |
| TE-A01 | GET /health 200 | api | MVP |
| TE-A02 | POST /v1/torrents invalid link 400 | api | MVP |
| TE-A03 | POST scope + POST mode paused all prio 0 | api | MVP |
| TE-I01 | add .torrent fixture → GET files list | integration | MVP |
| TE-I02 | Range bytes=0-1023 → 206 stable | integration | MVP |
| TE-I03 | DELETE removes hash directory | integration | MVP |
| TE-I04 | completing mode without stream progress increases | integration | phase2 |
| TE-I05 | restart reloads persisted torrents | integration | phase2 |
