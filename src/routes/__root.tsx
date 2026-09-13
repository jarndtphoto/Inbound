import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import { AuthProvider } from "@/lib/auth/provider";
import { PreviewHostBridge } from "@/components/preview-host-bridge";
import { AppProviders } from "@/components/providers";
import appCss from "../styles.css?url";
import appCssInline from "../styles.css?inline";

import { AppUpdateNotice } from "@/components/app-update-notice";

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
      { name: "viewport", content: "width=device-width, initial-scale=1, maximum-scale=1, minimum-scale=1, user-scalable=no" },
      { title: APP_NAME },
      { name: "description", content: "Your flight, stage by stage — inbound aircraft, route weather, turbulence, delays, and the gate." },
      { name: "theme-color", content: "#08090c" },
      { name: "color-scheme", content: "dark light" },
      { name: "apple-mobile-web-app-title", content: "Inbound" },
      { name: "apple-mobile-web-app-status-bar-style", content: "black-translucent" },
    ],
    links: [
      { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
      { rel: "stylesheet", href: stylesheetHref(appCss) },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700&family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap",
      },
      { rel: "manifest", href: "/manifest.webmanifest" },
      { rel: "apple-touch-icon", href: "/__grok/icon-180.png" },
      {
        rel: "apple-touch-startup-image",
        href: "/startup-1170x2532.png",
        media: "(device-width: 390px) and (device-height: 844px) and (-webkit-device-pixel-ratio: 3)",
      },
      {
        rel: "apple-touch-startup-image",
        href: "/startup-1125x2436.png",
        media: "(device-width: 375px) and (device-height: 812px) and (-webkit-device-pixel-ratio: 3)",
      },
      {
        rel: "apple-touch-startup-image",
        href: "/startup-1290x2796.png",
        media: "(device-width: 430px) and (device-height: 932px) and (-webkit-device-pixel-ratio: 3)",
      },
    ],
  }),
  component: () => (
    <html
      lang="en"
      className="dark h-full antialiased"
      style={{ background: "var(--color-bg)", color: "var(--color-fg)", height: "100%" }}
      suppressHydrationWarning
    >
      <head>
        <HeadContent />
        {typeof appCssInline === "string" && appCssInline.length > 0 ? (
          <style id="inbound-css" dangerouslySetInnerHTML={{ __html: appCssInline }} />
        ) : null}
      </head>
      <body className="h-full bg-bg text-fg" style={{ background: "var(--color-bg)", color: "var(--color-fg)", margin: 0, height: "100%" }} suppressHydrationWarning>
        <PreviewHostBridge />
        <AuthProvider>
          <AppProviders>
            <AppUpdateNotice />
            <Outlet />
          </AppProviders>
        </AuthProvider>
        <Scripts />
      </body>
    </html>
  ),
});
