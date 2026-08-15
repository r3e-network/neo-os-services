#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const read = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');

const publicSurfaces = [
  'apps/web/app/layout.tsx',
  'apps/web/app/page.tsx',
  'apps/web/app/docs/page.tsx',
  'apps/web/app/status/layout.tsx',
  'apps/web/app/status/page.tsx',
  'apps/web/components/dashboard.tsx',
  'apps/web/components/ui/Layout.tsx',
  'apps/web/lib/public-config.ts',
];

const combined = publicSurfaces.map((file) => `${file}\n${read(file)}`).join('\n');
const forbiddenProductPhrases = [
  'Morpheus Oracle Workbench',
  'Morpheus Documentation',
  'Morpheus workbench is ready.',
  'Neo Morpheus Network',
  '>MORPHEUS<',
  "default: 'Morpheus Oracle'",
  '>Morpheus Oracle</text>',
];

for (const phrase of forbiddenProductPhrases) {
  if (combined.includes(phrase)) {
    throw new Error(`public NeoOS surface still contains legacy product phrase: ${phrase}`);
  }
}

const requiredByFile = {
  'apps/web/app/layout.tsx': ['NeoOS Services'],
  'apps/web/app/page.tsx': ['NeoOS Oracle Workbench'],
  'apps/web/app/docs/page.tsx': ['NeoOS Services Documentation'],
  'apps/web/components/ui/Layout.tsx': ['NEOOS', 'NeoOS.'],
  'apps/web/lib/public-config.ts': ["'NeoOS Services'"],
};

for (const [file, fragments] of Object.entries(requiredByFile)) {
  const source = read(file);
  for (const fragment of fragments) {
    if (!source.includes(fragment)) {
      throw new Error(`${file} is missing required NeoOS brand fragment: ${fragment}`);
    }
  }
}

for (const file of ['apps/web/public/logo.png', 'apps/web/public/og-card.webp']) {
  const absolute = path.join(repoRoot, file);
  if (!fs.existsSync(absolute) || fs.statSync(absolute).size < 1024) {
    throw new Error(`${file} is missing or is not a production brand asset.`);
  }
}

const walk = (directory) =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory() && ['.next', 'coverage', 'node_modules'].includes(entry.name)) {
      return [];
    }
    return entry.isDirectory() ? walk(absolute) : [absolute];
  });

const webRoot = path.join(repoRoot, 'apps', 'web');
const yiwuReferences = walk(webRoot)
  .filter((file) => /\.(?:css|html|js|json|md|mjs|svg|ts|tsx)$/u.test(file))
  .filter((file) => read(path.relative(repoRoot, file)).toLowerCase().includes('yiwu'))
  .map((file) => path.relative(repoRoot, file));

if (yiwuReferences.length > 0) {
  throw new Error(`public Web sources still contain Yiwu branding: ${yiwuReferences.join(', ')}`);
}

console.log(`NeoOS brand check passed across ${publicSurfaces.length} public surfaces.`);
