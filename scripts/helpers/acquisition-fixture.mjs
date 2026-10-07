import { fileURLToPath } from 'node:url';

/**
 * Flight-story replays own their provider snapshots and synthetic clock. Replace
 * only the acquisition boundary in these test bundles: production coordination
 * is independently exercised by adsb-acquisition.test.mjs with real SQL.
 * Never install this plugin in the application Vite configuration.
 */
export function acquisitionFixture() {
  const runtime = fileURLToPath(new URL('./acquisition-fixture-runtime.mjs', import.meta.url));
  return {
    name: 'inbound-test-only-acquisition-fixture',
    enforce: 'pre',
    transform(code, id) {
      if (!/(?:^|\/)adsb-acquisition\.server\.ts$/.test(id)) return null;
      const original = 'export const acquireFreeAdsb = createAdsbAcquirer(defaultStore);';
      if (!code.includes(original)) throw new Error('Acquisition fixture boundary changed; update the replay adapter explicitly');
      return { code: code.replace(original, `export { acquireFreeAdsb } from ${JSON.stringify(runtime)};`), map: null };
    },
  };
}
