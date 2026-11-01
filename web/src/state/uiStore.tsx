import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

const EXPANDED_KEY = "home-cinema.library.expanded";

function loadExpanded(): Set<string> {
  try {
    const raw = sessionStorage.getItem(EXPANDED_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as string[];
    return new Set(arr);
  } catch {
    return new Set();
  }
}

function saveExpanded(set: Set<string>) {
  sessionStorage.setItem(EXPANDED_KEY, JSON.stringify([...set]));
}

type UiStore = {
  libraryExpanded: Set<string>;
  setLibraryExpanded: (next: Set<string>) => void;
  toggleLibraryExpanded: (hash: string) => boolean;
};

const UiContext = createContext<UiStore | null>(null);

export function UiStoreProvider({ children }: { children: ReactNode }) {
  const [libraryExpanded, setLibraryExpandedState] = useState<Set<string>>(loadExpanded);

  const setLibraryExpanded = useCallback((next: Set<string>) => {
    setLibraryExpandedState(next);
    saveExpanded(next);
  }, []);

  const toggleLibraryExpanded = useCallback(
    (hash: string) => {
      let opening = false;
      setLibraryExpandedState((prev) => {
        const next = new Set(prev);
        if (next.has(hash)) {
          next.delete(hash);
          opening = false;
        } else {
          next.add(hash);
          opening = true;
        }
        saveExpanded(next);
        return next;
      });
      return opening;
    },
    [],
  );

  const value = useMemo(
    () => ({
      libraryExpanded,
      setLibraryExpanded,
      toggleLibraryExpanded,
    }),
    [libraryExpanded, setLibraryExpanded, toggleLibraryExpanded],
  );

  return <UiContext.Provider value={value}>{children}</UiContext.Provider>;
}

export function useUiStore() {
  const ctx = useContext(UiContext);
  if (!ctx) throw new Error("useUiStore requires UiStoreProvider");
  return ctx;
}
