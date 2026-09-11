import { createRouter } from "@tanstack/react-router";
import { AppErrorComponent } from "@/lib/error-component";
import { routeTree } from "./routeTree.gen";

function DarkPending() {
  return (
    <div style={{ background: "#08090c", color: "#e7eaee", minHeight: "100dvh" }} />
  );
}

export function getRouter() {
  return createRouter({
    routeTree,
    defaultErrorComponent: AppErrorComponent,
    defaultPendingComponent: DarkPending,
  });
}