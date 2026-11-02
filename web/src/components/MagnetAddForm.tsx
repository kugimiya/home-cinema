import { FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import { preparePlayMagnet } from "../api/client";
import { isValidMagnetLink, normalizeMagnetInput } from "../lib/magnet";

type Props = {
  /** Shorter layout on library page */
  compact?: boolean;
};

export default function MagnetAddForm({ compact }: Props) {
  const navigate = useNavigate();
  const [magnetInput, setMagnetInput] = useState("");
  const [title, setTitle] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const magnet = normalizeMagnetInput(magnetInput);
    if (!magnet || !isValidMagnetLink(magnet)) {
      setError("Вставьте magnet-ссылку (magnet:?…) или info-hash раздачи");
      return;
    }
    setLoading(true);
    try {
      const res = await preparePlayMagnet(
        magnet,
        title.trim() || undefined,
      );
      navigate(`/watch/${encodeURIComponent(res.hash)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className={`magnet-add-panel${compact ? " magnet-add-panel--compact" : ""}`}>
      <h2 className="magnet-add-heading">По magnet-ссылке</h2>
      {!compact && (
        <p className="muted">
          Если раздачи нет в поиске — вставьте magnet или hash и перейдите к выбору файла.
        </p>
      )}
      <form className="magnet-add-form" onSubmit={(e) => void onSubmit(e)}>
        <label className="magnet-add-field">
          <span className="magnet-add-label">Magnet / hash</span>
          <textarea
            value={magnetInput}
            onChange={(e) => setMagnetInput(e.target.value)}
            placeholder="magnet:?xt=urn:btih:…"
            rows={compact ? 2 : 3}
            disabled={loading}
            spellCheck={false}
          />
        </label>
        <label className="magnet-add-field magnet-add-field--title">
          <span className="magnet-add-label">Название (необязательно)</span>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Как показать в библиотеке"
            disabled={loading}
          />
        </label>
        <div className="magnet-add-actions">
          <button type="submit" disabled={loading || !magnetInput.trim()}>
            {loading ? "Добавляем…" : "Добавить и смотреть"}
          </button>
        </div>
      </form>
      {error && <p className="error">{error}</p>}
    </section>
  );
}
