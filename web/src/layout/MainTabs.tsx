import { useMatch } from "react-router-dom";
import SearchPage from "../pages/Search";
import LibraryPage from "../pages/Library";

export default function MainTabs() {
  const onSearch = useMatch({ path: "/", end: true });
  const onLibrary = useMatch("/library");

  return (
    <>
      <div style={{ display: onSearch ? "block" : "none" }}>
        <SearchPage />
      </div>
      <div style={{ display: onLibrary ? "block" : "none" }}>
        <LibraryPage />
      </div>
    </>
  );
}
