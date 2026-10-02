import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";

type Appearance = "auto" | "light" | "dark";
const KEY = "inbound-appearance";

export function AppearanceControl() {
  const [mode, setMode] = useState<Appearance>("auto");
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState(false);
  const [dark, setDark] = useState(false);
  useEffect(() => {
    let saved: Appearance = "auto";
    try {
      const value = localStorage.getItem(KEY);
      if (value === "auto" || value === "light" || value === "dark") saved = value;
      else if (localStorage.getItem("inbound-theme") === "sunset") saved = "dark";
      else if (localStorage.getItem("inbound-theme") === "sunrise") saved = "light";
    } catch { /* Appearance works without storage. */ }
    setMode(saved);
    setLoaded(true);
  }, []);
  useEffect(() => {
    if (!loaded) return;
    const apply = () => {
      const hour = new Date().getHours();
      const night = mode === "dark" || (mode === "auto" && (hour < 7 || hour >= 19));
      document.documentElement.dataset.theme = night ? "sunset" : "sunrise";
      document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach(meta => { meta.content = night ? "#081725" : "#fcfaf5"; });
      document.querySelectorAll<HTMLMetaElement>('meta[name="apple-mobile-web-app-status-bar-style"]').forEach(meta => { meta.content = "black-translucent"; });
      document.documentElement.style.colorScheme = night ? "dark" : "light";
      setDark(night);
    };
    apply();
    const timer = window.setInterval(apply, 30_000);
    document.addEventListener("visibilitychange", apply);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", apply); };
  }, [mode, loaded]);
  return <div className="appearance-control">
    <button type="button" aria-label="Appearance" aria-expanded={open} onClick={() => setOpen(!open)}>
      {dark ? <Moon aria-hidden="true" /> : <Sun aria-hidden="true" />}
    </button>
    {open && <div className="appearance-menu" role="group" aria-label="Appearance">
      {(["auto", "light", "dark"] as const).map(value => <button key={value} type="button" aria-pressed={value === mode} onClick={() => {
        setMode(value);
        try { localStorage.setItem(KEY, value); } catch { /* Optional. */ }
        setOpen(false);
      }}>{value[0].toUpperCase() + value.slice(1)}</button>)}
      <p>Auto: Light 7 AM–7 PM<br />Device local time</p>
    </div>}
  </div>;
}
