import { createRouter } from "@tanstack/react-router";
import { AppErrorComponent } from "@/lib/error-component";
import { routeTree } from "./routeTree.gen";

function DarkPending() {
  return (
    <div
      style={{
        background: "#08090c",
        color: "#e7eaee",
        minHeight: "100dvh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "2rem",
      }}
    >
      <p style={{ fontFamily: "Barlow Condensed, sans-serif", fontSize: "2rem", fontWeight: 600, margin: 0 }}>
        Inbound
      </p>
      <p style={{ margin: "0.75rem 0 0", fontSize: "0.875rem", color: "#8b929c" }}>Loading your flight…</p>
    </div>
  );
}

export function getRouter() {
  return createRouter({
    routeTree,
    defaultErrorComponent: AppErrorComponent,
    defaultPendingComponent: DarkPending,
  });
}