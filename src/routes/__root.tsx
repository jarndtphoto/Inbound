import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import { AuthProvider } from "@/lib/auth/provider";
import { PreviewHostBridge } from "@/components/preview-host-bridge";
import { AppProviders } from "@/components/providers";
import appCss from "../styles.css?url";
import appCssInline from "../styles.css?inline";

const APP_NAME = "Inbound";

function stylesheetHref(href: string) {
  if (!href) return href;
  if (href.includes("/assets/")) return href;
  const base = href.split("?")[0] || href;
  return `${base}?direct`;
}

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1, maximum-scale=1, minimum-scale=1, user-scalable=no, viewport-fit=cover" },
      { title: APP_NAME },
      { name: "description", content: "Your flight, stage by stage — inbound aircraft, route weather, turbulence, delays, and the gate." },
      { name: "theme-color", content: "#fcfaf5" },
      { name: "color-scheme", content: "light dark" },
      { name: "mobile-web-app-capable", content: "yes" },
      { name: "apple-mobile-web-app-capable", content: "yes" },
      { name: "apple-mobile-web-app-title", content: "Inbound" },
      { name: "apple-mobile-web-app-status-bar-style", content: "black-translucent" },
      { name: "format-detection", content: "telephone=no" },
    ],
    links: [
      { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
      { rel: "stylesheet", href: stylesheetHref(appCss) },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700&family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap",
      },
      { rel: "manifest", href: "/inbound.webmanifest" },
      { rel: "apple-touch-icon", href: "/inbound-icon-180.png" },
    ],
  }),
  component: () => (
    <html
      lang="en"
      className="h-full antialiased"
      data-theme="sunrise"
      style={{ background: "#fcfaf5", height: "100%" }}
      suppressHydrationWarning
    >
      <head>
        <HeadContent />
        <script dangerouslySetInnerHTML={{ __html: `(() => { let mode = "auto"; try { mode = localStorage.getItem("inbound-appearance") || (localStorage.getItem("inbound-theme") === "sunset" ? "dark" : localStorage.getItem("inbound-theme") === "sunrise" ? "light" : "auto"); } catch {} const hour = new Date().getHours(); const dark = mode === "dark" || (mode !== "light" && (hour < 7 || hour >= 19)); document.documentElement.dataset.theme = dark ? "sunset" : "sunrise"; document.documentElement.style.colorScheme = dark ? "dark" : "light"; document.querySelectorAll('meta[name="theme-color"]').forEach(meta => { meta.content = dark ? "#081725" : "#fcfaf5"; }); })();` }} />
        {typeof appCssInline === "string" && appCssInline.length > 0 ? (
          <style id="inbound-css" dangerouslySetInnerHTML={{ __html: appCssInline }} />
        ) : null}
      </head>
      <body className="h-full bg-bg text-fg" style={{ background: "#fcfaf5", margin: 0, height: "100%" }} suppressHydrationWarning>
        <PreviewHostBridge />
        <AuthProvider>
          <AppProviders>
            <Outlet />
          </AppProviders>
        </AuthProvider>
        <Scripts />
      </body>
    </html>
  ),
});
