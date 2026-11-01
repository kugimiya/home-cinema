import { useLocation, useNavigate } from "react-router-dom";
import type { PlayResponse } from "../api/client";

export default function PlayerPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const state = location.state as PlayResponse | null;

  if (!state?.stream_url) {
    return (
      <div>
        <p className="error">Нет активного потока.</p>
        <button type="button" className="secondary" onClick={() => navigate("/")}>
          К поиску
        </button>
      </div>
    );
  }

  const copyUrl = () => navigator.clipboard.writeText(state.stream_url);

  return (
    <div>
      <h1>{state.title}</h1>
      <p className="muted">
        {state.file_name} · hash {state.hash.slice(0, 8)}…
      </p>
      <div className="player-wrap">
        <video src={state.stream_url} controls autoPlay />
      </div>
      <div className="actions">
        <button type="button" onClick={copyUrl}>
          Скопировать URL потока
        </button>
        <button type="button" className="secondary" onClick={() => navigate("/library")}>
          Библиотека
        </button>
      </div>
      <p className="muted" style={{ marginTop: "1rem" }}>
        Для VLC/MPV: File → Open Network → вставьте URL выше. Торрент продолжит качаться и
        раздаваться после просмотра.
      </p>
    </div>
  );
}
