import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('runtime route inventory', () => {
  it('does not retain the retired game proxy family', () => {
    for (const action of ['start', 'move', 'finalize']) {
      expect(existsSync(resolve(appRoot, `app/api/game/${action}/route.ts`))).toBe(false);
    }
  });
});
