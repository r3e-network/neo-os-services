import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DOCS_NAVIGATION_SECTIONS, flattenDocsNavigation } from '../lib/docs-navigation';

const appDir = path.resolve(process.cwd(), 'app');
const docsDir = path.resolve(process.cwd(), '../../docs');

function routeFromPage(pageFile: string) {
  const relative = path.relative(appDir, pageFile).split(path.sep).join('/');
  return `/${relative}`.replace(/\/page\.tsx$/, '').replace(/\/index$/, '') || '/';
}

function listStaticDocsRoutes(dir = path.join(appDir, 'docs')): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (
          entry.name.startsWith('[') ||
          entry.name.startsWith('(') ||
          entry.name.startsWith('_')
        ) {
          return [];
        }
        return listStaticDocsRoutes(fullPath);
      }
      return entry.isFile() && entry.name === 'page.tsx' ? [routeFromPage(fullPath)] : [];
    })
    .sort();
}

describe('docs navigation contract', () => {
  it('links every static docs page exactly once in the docs sidebar', () => {
    const staticDocsRoutes = listStaticDocsRoutes();
    const linkedDocsRoutes = flattenDocsNavigation(DOCS_NAVIGATION_SECTIONS)
      .filter((item) => !item.href.includes('/docs/r/'))
      .map((item) => item.href)
      .sort();

    expect(linkedDocsRoutes).toEqual(staticDocsRoutes);
  });

  it('does not contain duplicate documentation links', () => {
    const hrefs = flattenDocsNavigation(DOCS_NAVIGATION_SECTIONS).map((item) => item.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it('links every extended markdown document to an existing docs file', () => {
    const missingDocs = flattenDocsNavigation(DOCS_NAVIGATION_SECTIONS)
      .filter((item) => item.href.startsWith('/docs/r/'))
      .map((item) => item.href.replace('/docs/r/', ''))
      .filter((slug) => !fs.existsSync(path.join(docsDir, `${slug}.md`)));

    expect(missingDocs).toEqual([]);
  });
});
