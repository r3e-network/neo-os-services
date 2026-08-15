import fs from 'fs';
import path from 'path';
import matter from 'gray-matter';

const docsDirectory = path.join(process.cwd(), '../../docs');

export function getDocBySlug(slug: string) {
  const realSlug = slug.replace(/\.md$/, '');

  // Doc slugs are flat filenames under docs/. The /docs/r/[slug] route is
  // public and unauthenticated, so reject anything containing path separators
  // or parent-directory segments before touching the filesystem to prevent
  // traversal to arbitrary .md files on the host.
  if (!/^[A-Za-z0-9._-]+$/.test(realSlug) || realSlug.includes('..')) {
    return null;
  }

  const docsRoot = path.resolve(docsDirectory);
  const fullPath = path.resolve(docsRoot, `${realSlug}.md`);

  // Defense in depth: ensure the resolved path stays inside the docs directory.
  if (!fullPath.startsWith(docsRoot + path.sep)) {
    return null;
  }

  if (!fs.existsSync(fullPath)) {
    return null;
  }

  const fileContents = fs.readFileSync(fullPath, 'utf8');
  const { data, content } = matter(fileContents);

  return { slug: realSlug, meta: data, content };
}
