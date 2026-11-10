import { useCallback, useEffect, useState } from "preact/hooks";

/** Keeps the open tab in the address hash (`#news`, `#postings`, `#progress`). */
export function useHashTab<T extends string>(tabs: readonly T[]): [T, (tab: T) => void] {
  const fallback = tabs[0];
  if (fallback === undefined) throw new Error("useHashTab needs at least one tab");

  const read = useCallback((): T => {
    const hash = window.location.hash.slice(1);
    return tabs.find((tab) => tab === hash) ?? fallback;
  }, [tabs, fallback]);

  const [tab, setTab] = useState<T>(read);

  useEffect(() => {
    const onHashChange = () => {
      setTab(read());
    };
    window.addEventListener("hashchange", onHashChange);
    return () => {
      window.removeEventListener("hashchange", onHashChange);
    };
  }, [read]);

  const select = useCallback((next: T) => {
    setTab(next);
    if (window.location.hash !== `#${next}`) window.location.hash = next;
  }, []);

  return [tab, select];
}
