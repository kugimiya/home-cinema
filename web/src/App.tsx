import { NavLink, Route, Routes } from "react-router-dom";
import SearchPage from "./pages/Search";
import LibraryPage from "./pages/Library";
import PlayerPage from "./pages/Player";

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
      </nav>
      <Routes>
        <Route path="/" element={<SearchPage />} />
        <Route path="/library" element={<LibraryPage />} />
        <Route path="/player" element={<PlayerPage />} />
      </Routes>
    </div>
  );
}
