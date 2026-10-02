import { useSyncExternalStore } from "react";

function subscribe(onChange: () => void) {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}
const visible = () => document.visibilityState === "visible";
const serverVisible = () => true;

export function usePageVisible() {
  return useSyncExternalStore(subscribe, visible, serverVisible);
}
