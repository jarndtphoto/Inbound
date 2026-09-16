import { createFileRoute } from "@tanstack/react-router";
import { FiledApp } from "@/components/filed-app";
import { AppErrorComponent } from "@/lib/error-component";
import { useEffect } from "react";

export const Route = createFileRoute("/")({
  component: Home,
  errorComponent: AppErrorComponent,
});

function Home() {
  useEffect(() => {
    const normalizeDepartureCopy = () => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node: Node | null;
      while ((node = walker.nextNode())) {
        const text = node.nodeValue;
        if (!text) continue;
        if (text === "Taxiing out") node.nodeValue = "Heading to runway";
        else if (text.startsWith("Taxiing out · ")) node.nodeValue = text.replace(/^Taxiing out/, "Heading to runway");
      }
    };

    normalizeDepartureCopy();
    const observer = new MutationObserver(normalizeDepartureCopy);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, []);

  return <FiledApp />;
}
