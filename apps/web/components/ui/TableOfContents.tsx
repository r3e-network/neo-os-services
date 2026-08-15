'use client';

import { useEffect, useState } from 'react';

export interface TocItem {
  id: string;
  text: string;
  level: number;
}

interface TableOfContentsProps {
  items: TocItem[];
}

export function TableOfContents({ items }: TableOfContentsProps) {
  const [activeId, setActiveId] = useState<string>('');

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setActiveId(entry.target.id);
          }
        });
      },
      { rootMargin: '0% 0% -80% 0%' }
    );

    items.forEach((item) => {
      const element = document.getElementById(item.id);
      if (element) observer.observe(element);
    });

    return () => observer.disconnect();
  }, [items]);

  if (!items.length) return null;

  return (
    <div
      className="toc-container"
      style={{
        position: 'sticky',
        top: '100px',
        maxHeight: 'calc(100vh - 120px)',
        overflowY: 'auto',
        marginLeft: '2.5rem',
        paddingLeft: '1.25rem',
        borderLeft: '1px solid rgba(255, 255, 255, 0.06)',
        width: '220px',
        display: 'none',
        flexShrink: 0,
      }}
    >
      <span
        style={{
          display: 'block',
          fontSize: '0.65rem',
          fontWeight: 800,
          color: 'var(--text-muted)',
          textTransform: 'uppercase',
          letterSpacing: 0,
          marginBottom: '1rem',
          fontFamily: 'var(--font-mono)',
        }}
      >
        On this page
      </span>
      <nav style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        {items.map((item) => (
          <a
            key={item.id}
            href={`#${item.id}`}
            style={{
              fontSize: '0.8rem',
              color: activeId === item.id ? 'var(--neo-green)' : 'var(--text-secondary)',
              textDecoration: 'none',
              paddingLeft: `${Math.max(0, (item.level - 2) * 1)}rem`,
              transition: 'color 0.2s',
              lineHeight: 1.4,
              fontWeight: activeId === item.id ? 700 : 400,
            }}
            className="hover-link"
          >
            {item.text}
          </a>
        ))}
      </nav>
      <style>{`
 @media (min-width: 1280px) {
 .toc-container {
 display: block !important;
 }
 }
 .toc-container::-webkit-scrollbar { width: 2px; }
 .toc-container::-webkit-scrollbar-thumb { background: var(--border-dim); }
 `}</style>
    </div>
  );
}
