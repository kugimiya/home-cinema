import asyncio
import time
import unittest
from unittest.mock import AsyncMock, MagicMock

from app.torr_cache import TorrStateCache


class TorrCacheTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.client = MagicMock()
        self.client.list_torrents = AsyncMock(
            return_value=[
                {
                    "hash": "aa" * 20,
                    "title": "One",
                    "file_stats": [{"id": 1, "path": "a.mkv", "length": 100}],
                }
            ]
        )
        self.client.get_torrent = AsyncMock(return_value={})
        self.client.get_cache = AsyncMock(return_value={"pieces": []})
        self.cache = TorrStateCache(self.client)

    async def test_list_coalesced(self) -> None:
        async def slow_list() -> list:
            await asyncio.sleep(0.05)
            return await self.client.list_torrents.return_value

        self.client.list_torrents = AsyncMock(side_effect=slow_list)
        a, b = await asyncio.gather(
            self.cache.list_snapshot(),
            self.cache.list_snapshot(),
        )
        self.assertIs(a, b)
        self.assertEqual(self.client.list_torrents.await_count, 1)

    async def test_list_ttl(self) -> None:
        await self.cache.list_snapshot(max_age=10)
        await self.cache.list_snapshot(max_age=10)
        self.assertEqual(self.client.list_torrents.await_count, 1)

    async def test_invalidate_list(self) -> None:
        await self.cache.list_snapshot()
        self.cache.invalidate_list()
        await self.cache.list_snapshot()
        self.assertEqual(self.client.list_torrents.await_count, 2)

    async def test_invalidate_hash(self) -> None:
        h = "aa" * 20
        await self.cache.get_cache_pieces(h)
        self.assertEqual(self.client.get_cache.await_count, 1)
        self.cache.invalidate_hash(h, ["cache"])
        await self.cache.get_cache_pieces(h)
        self.assertEqual(self.client.get_cache.await_count, 2)

    async def test_stat5_skips_cache(self) -> None:
        h = "bb" * 20
        await self.cache.get_cache_pieces(h, list_item={"stat": 5})
        self.client.get_cache.assert_not_called()


if __name__ == "__main__":
    unittest.main()
