import type { Provider } from "./models.js";

const PROVIDER_LABELS: Record<Provider, string> = {
  rutracker: "RuTracker",
  kinozal: "Kinozal",
  rutor: "RuTor",
  nonameclub: "NoNameClub",
  rutor_direct: "RuTor",
};

export function providerLabel(provider: Provider | string | null | undefined): string {
  if (provider == null) return "—";
  if (typeof provider === "string") {
    try {
      return PROVIDER_LABELS[provider as Provider] ?? provider;
    } catch {
      return String(provider);
    }
  }
  return PROVIDER_LABELS[provider] ?? provider;
}
