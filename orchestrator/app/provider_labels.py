from __future__ import annotations

from app.models import Provider

PROVIDER_LABELS: dict[Provider, str] = {
    Provider.rutracker: "RuTracker",
    Provider.kinozal: "Kinozal",
    Provider.rutor: "RuTor",
    Provider.nonameclub: "NoNameClub",
    Provider.rutor_direct: "RuTor",
}


def provider_label(provider: Provider | str | None) -> str:
    if provider is None:
        return "—"
    if isinstance(provider, Provider):
        return PROVIDER_LABELS.get(provider, provider.value)
    try:
        return PROVIDER_LABELS.get(Provider(provider), str(provider))
    except ValueError:
        return str(provider)
