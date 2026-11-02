import { NavLink, Route, Routes } from "react-router-dom";
import ServiceStatusBar from "./components/ServiceStatusBar";
import MainTabs from "./layout/MainTabs";
import PlayerPage from "./pages/Player";
import WatchPreparePage from "./pages/WatchPrepare";
import WatchSelectPage from "./pages/WatchSelect";
import EngineMonitorPage from "./pages/EngineMonitor";

export default function App() {
  return (
    <div className="layout">
      <nav>
        <NavLink to="/" end className={({ isActive }) => (isActive ? "active" : "")}>
          Поиск
        </NavLink>
        <NavLink to="/library" className={({ isActive }) => (isActive ? "active" : "")}>
          Библиотека
        </NavLink>
        <NavLink to="/engine" className={({ isActive }) => (isActive ? "active" : "")}>
          Libtorrent
        </NavLink>
      </nav>
      <ServiceStatusBar />
      <Routes>
        <Route path="/" element={<MainTabs />} />
        <Route path="/library" element={<MainTabs />} />
        <Route path="/watch/prepare/:provider/:externalId" element={<WatchPreparePage />} />
        <Route path="/watch/:infoHash" element={<WatchSelectPage />} />
        <Route path="/player/:infoHash/:fileIndex" element={<PlayerPage />} />
        <Route path="/engine" element={<EngineMonitorPage />} />
      </Routes>
    </div>
  );
}
