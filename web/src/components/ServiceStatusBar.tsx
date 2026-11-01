import { useCallback, useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import {
  fetchSystemStatus,
  restartService,
  type ServiceStatus,
  type ServiceState,
} from "../api/client";

const POLL_MS = 10000;
const POLL_MS_PLAYER = 20000;

const STATE_CLASS: Record<ServiceState, string> = {
  ok: "status-ok",
  busy: "status-busy",
  degraded: "status-degraded",
  down: "status-down",
  unknown: "status-unknown",
};

export default function ServiceStatusBar() {
  const location = useLocation();
  const onPlayer = location.pathname.startsWith("/player");
  const pollMs = onPlayer ? POLL_MS_PLAYER : POLL_MS;
  const [services, setServices] = useState<ServiceStatus[]>([]);
  const [restarting, setRestarting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await fetchSystemStatus();
      setServices(data.services);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => {
      if (document.visibilityState === "hidden") return;
      void load();
    }, pollMs);
    return () => clearInterval(t);
  }, [load, pollMs]);

  async function onRestart(svc: ServiceStatus) {
    if (!svc.restart_allowed) return;
    const label = svc.label;
    if (
      !confirm(
        `Перезапустить ${label}? Активные просмотры и загрузки могут прерваться.`,
      )
    ) {
      return;
    }
    setRestarting(svc.id);
    setError(null);
    try {
      await restartService(svc.id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRestarting(null);
    }
  }

  return (
    <div className="service-status-bar" aria-live="polite">
      {error && <p className="error service-status-error">{error}</p>}
      {services.map((svc) => (
        <div key={svc.id} className="service-status-row">
          <span
            className={`status-dot ${STATE_CLASS[svc.state] ?? "status-unknown"}`}
            aria-hidden
          />
          <span className="service-status-label">{svc.label}</span>
          <span className="service-status-activity" title={svc.activity}>
            {svc.activity}
          </span>
          {svc.restart_allowed ? (
            <button
              type="button"
              className="secondary service-restart-btn"
              disabled={restarting === svc.id}
              onClick={() => onRestart(svc)}
            >
              {restarting === svc.id ? "…" : "Перезагрузить"}
            </button>
          ) : (
            <span className="service-restart-placeholder" />
          )}
        </div>
      ))}
    </div>
  );
}
