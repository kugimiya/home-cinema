from app.models import Provider
from app.provider_labels import provider_label
from app.torrent_fetch import looks_like_torrent_file, torrent_download_url
from app.models import ReleaseDetail


def test_provider_labels() -> None:
    assert provider_label(Provider.rutracker) == "RuTracker"
    assert provider_label(Provider.rutor_direct) == "RuTor"


def test_rutor_torrent_url() -> None:
    detail = ReleaseDetail(
        provider=Provider.rutor_direct,
        external_id="123",
        title="x",
        magnet="magnet:?xt=urn:btih:abc",
    )
    assert torrent_download_url(detail) == "https://d.rutor.info/download/123"


def test_looks_like_torrent() -> None:
    assert looks_like_torrent_file(b"d8:announce" + b"x" * 24)
    assert not looks_like_torrent_file(b"<html>")
    assert not looks_like_torrent_file(b"")
