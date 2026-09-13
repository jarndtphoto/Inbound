import { useEffect, useState } from "react";

export function AppUpdateNotice() {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    let active = true;
    let busy = false;
    const check = async () => {
      if (busy || document.visibilityState !== "visible") return;
      busy = true;
      try {
        const response = await fetch("/inbound-version.json?check=" + Date.now(), {
          cache: "no-store", signal: AbortSignal.timeout(8000),
        });
        if (!response.ok) return;
        const data = await response.json();
        if (active && typeof data.version === "string" &&
          data.version !== import.meta.env.VITE_INBOUND_RELEASE) setAvailable(true);
      } catch { /* Keep the current app usable when offline. */ }
      finally { busy = false; }
    };
    void check();
    const timer = window.setInterval(check, 60000);
    document.addEventListener("visibilitychange", check);
    window.addEventListener("online", check);
    return () => {
      active = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", check);
      window.removeEventListener("online", check);
    };
  }, []);
  return available ? <div role="status" className="fixed inset-x-3 top-3 z-[100] mx-auto flex max-w-lg items-center justify-between gap-3 rounded-xl border border-accent bg-surface p-3 text-sm text-fg shadow-lg">
    <p>A new version of Inbound is ready.</p>
    <button type="button" onClick={() => window.location.reload()} className="shrink-0 rounded-lg bg-accent px-3 py-2 font-semibold text-accent-fg">Update now</button>
  </div> : null;
}
