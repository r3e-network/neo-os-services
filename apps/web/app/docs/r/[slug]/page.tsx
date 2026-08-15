import { notFound } from 'next/navigation';
import { getDocBySlug } from '@/lib/mdx';
import { MarkdownRenderer } from '@/components/ui/MarkdownRenderer';
import { TableOfContents, TocItem } from '@/components/ui/TableOfContents';
import { BookOpen } from 'lucide-react';
import GithubSlugger from 'github-slugger';

interface PageProps {
  params: Promise<{ slug: string }>;
}

function extractToc(content: string): TocItem[] {
  const slugger = new GithubSlugger();
  const headings = content.match(/^(#{2,4})\s+(.+)$/gm) || [];
  return headings.map((heading) => {
    const level = heading.match(/^(#+)/)![1].length;
    let text = heading.replace(/^(#+)\s+/, '');
    // Drop image syntax entirely (rehype-slug ignores <img> in heading text).
    text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
    // Reduce links to their visible label, matching the rendered text content.
    text = text.replace(/\[(.*?)\]\(.*?\)/g, '$1');
    // The slug must be derived from the same plain text content that
    // rehype-slug sees in MarkdownRenderer, so strip inline markdown syntax
    // (code backticks and emphasis markers) that would otherwise be slugged.
    text = text.replace(/`/g, '');
    text = text.replace(/(\*\*|__|\*|_|~~)/g, '');
    text = text.trim();
    return {
      id: slugger.slug(text),
      text,
      level,
    };
  });
}

export default async function MarkdownDocPage({ params }: PageProps) {
  const resolvedParams = await params;
  const doc = getDocBySlug(resolvedParams.slug);

  if (!doc) {
    return notFound();
  }

  const tocItems = extractToc(doc.content);

  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', minWidth: 0 }}>
      <div className="fade-in" style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '1rem' }}>
          <BookOpen size={14} color="var(--neo-green)" />
          <span
            style={{
              fontSize: '0.7rem',
              fontWeight: 800,
              color: 'var(--text-muted)',
              textTransform: 'uppercase',
              letterSpacing: 0,
              fontFamily: 'var(--font-mono)',
            }}
          >
            EXTENDED DOCUMENTATION
          </span>
        </div>
        <MarkdownRenderer content={doc.content} />
      </div>
      {tocItems.length > 0 && <TableOfContents items={tocItems} />}
    </div>
  );
}
