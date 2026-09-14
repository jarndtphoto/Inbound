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
      { name: "theme-color", content: "#faf7f1" },
      { name: "color-scheme", content: "light dark" },
      { name: "mobile-web-app-capable", content: "yes" },
      { name: "apple-mobile-web-app-capable", content: "yes" },
      { name: "apple-mobile-web-app-title", content: "Inbound" },
      { name: "apple-mobile-web-app-status-bar-style", content: "default" },
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
      style={{ background: "#faf7f1", height: "100%" }}
      suppressHydrationWarning
    >
      <head>
        <HeadContent />
        {typeof appCssInline === "string" && appCssInline.length > 0 ? (
          <style id="inbound-css" dangerouslySetInnerHTML={{ __html: appCssInline }} />
        ) : null}
      </head>
      <body className="h-full bg-bg text-fg" style={{ background: "#faf7f1", margin: 0, height: "100%" }} suppressHydrationWarning>
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
