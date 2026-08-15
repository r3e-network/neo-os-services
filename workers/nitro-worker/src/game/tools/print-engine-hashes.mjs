// Print the appId -> engineHash manifest (sha256 of each wrapper module source).
// Run after a reviewed engine change to regenerate the pinned ENGINE_MANIFEST in
// registry.js, then re-approve.
import { __rebuildRegistryForTests, registryManifest } from '../registry.js';

__rebuildRegistryForTests({ strict: false, skipPinCheck: true });
const manifest = registryManifest();
for (const [appId, hash] of Object.entries(manifest)) {
  process.stdout.write(`${appId} ${hash}\n`);
}
