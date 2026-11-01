import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { preparePlay, type Provider } from "../api/client";

export default function WatchPreparePage() {
  const { provider, externalId } = useParams<{ provider: string; externalId: string }>();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    if (!provider || !externalId) {
      setError("Не указана раздача");
      return;
    }
    started.current = true;
    void (async () => {
      try {
        const res = await preparePlay(provider as Provider, externalId);
        navigate(`/watch/${encodeURIComponent(res.hash)}`, { replace: true });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [provider, externalId, navigate]);

  if (error) {
    return (
      <div>
        <p className="error">{error}</p>
        <button type="button" className="secondary" onClick={() => navigate("/")}>
          К поиску
        </button>
      </div>
    );
  }

  return (
    <div>
      <p className="muted">Добавляем торрент и получаем метаданные…</p>
      <div className="spinner" />
    </div>
  );
}
