import { createFileRoute } from "@tanstack/react-router";
import { FiledApp } from "@/components/filed-app";
import { AppErrorComponent } from "@/lib/error-component";

export const Route = createFileRoute("/")({
  component: Home,
  errorComponent: AppErrorComponent,
});

function Home() {
  return <FiledApp />;
}