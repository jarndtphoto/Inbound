import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const root = readFileSync(new URL("../src/routes/__root.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const manifest = JSON.parse(readFileSync(new URL("../public/inbound.webmanifest", import.meta.url), "utf8"));

function pngDimensions(path) {
  const bytes = readFileSync(new URL(path, import.meta.url));
  assert.equal(bytes.toString("ascii", 1, 4), "PNG");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), colorType: bytes[25] };
}

describe("Inbound iPhone Home Screen app", () => {
  it("ships a scoped standalone manifest with a light launch background", () => {
    assert.equal(manifest.name, "Inbound");
    assert.equal(manifest.short_name, "Inbound");
    assert.equal(manifest.start_url, "/");
    assert.equal(manifest.scope, "/");
    assert.equal(manifest.display, "standalone");
    assert.equal(manifest.background_color, "#faf7f1");
  });

  it("declares Apple standalone metadata and edge-to-edge safe-area support", () => {
    assert.match(root, /apple-mobile-web-app-capable.*yes/);
    assert.match(root, /apple-mobile-web-app-title.*Inbound/);
    assert.match(root, /apple-mobile-web-app-status-bar-style.*default/);
    assert.match(root, /viewport-fit=cover/);
    assert.match(root, /apple-touch-icon.*inbound-icon-180\.png/);
    assert.doesNotMatch(root, /apple-touch-startup-image/, "legacy black launch images must not override the light app background");
    assert.match(css, /@media \(display-mode: standalone\)/);
    assert.match(css, /safe-area-inset-top/);
    assert.match(css, /safe-area-inset-bottom/);
  });

  it("uses opaque, correctly sized Home Screen icons", () => {
    for (const [path, size] of [["../public/inbound-icon-180.png", 180], ["../public/inbound-icon-192.png", 192], ["../public/inbound-icon-512.png", 512]]) {
      const icon = pngDimensions(path);
      assert.deepEqual([icon.width, icon.height], [size, size]);
      assert.equal(icon.colorType, 2, `${path} must be opaque RGB rather than transparent RGBA`);
    }
  });
});
