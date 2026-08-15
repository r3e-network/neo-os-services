'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import rehypeSlug from 'rehype-slug';
import { CodeBlock } from './CodeBlock';

interface MarkdownRendererProps {
  content: string;
}

export function MarkdownRenderer({ content }: MarkdownRendererProps) {
  return (
    <div className="fade-in">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeRaw, rehypeSlug]}
        components={{
          code({ inline, className, children, ...props }: any) {
            const match = /language-(\w+)/.exec(className || '');
            const codeString = String(children).replace(/\n$/, '');

            if (!inline && match) {
              return <CodeBlock code={codeString} language={match[1]} />;
            } else if (!inline) {
              return <CodeBlock code={codeString} language="text" />;
            }
            return (
              <code className={className} {...props}>
                {children}
              </code>
            );
          },
          table({ children, ...props }) {
            return (
              <div
                style={{
                  overflowX: 'auto',
                  marginBottom: '2.5rem',
                  border: '1px solid var(--border-dim)',
                  borderRadius: 'var(--ns-radius-sm)',
                }}
              >
                <table
                  style={{ width: '100%', borderCollapse: 'collapse', background: 'transparent' }}
                  {...props}
                >
                  {children}
                </table>
              </div>
            );
          },
          th({ children, ...props }) {
            return (
              <th
                style={{
                  padding: '0.75rem 1rem',
                  textAlign: 'left',
                  borderBottom: '1px solid var(--border-dim)',
                  background: 'rgba(83, 58, 253, 0.06)',
                  color: 'var(--text-primary)',
                  fontSize: '0.8rem',
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  letterSpacing: 0,
                }}
                {...props}
              >
                {children}
              </th>
            );
          },
          td({ children, ...props }) {
            return (
              <td
                style={{
                  padding: '0.75rem 1rem',
                  borderBottom: '1px solid var(--border-dim)',
                  color: 'var(--text-secondary)',
                  fontSize: '0.85rem',
                }}
                {...props}
              >
                {children}
              </td>
            );
          },
          a({ children, href, ...props }) {
            return (
              <a
                href={href}
                style={{
                  color: 'var(--neo-green)',
                  textDecoration: 'none',
                  borderBottom: '1px solid var(--neo-green)',
                }}
                {...props}
              >
                {children}
              </a>
            );
          },
          img({ src, alt, ...props }) {
            return (
              <img
                src={src}
                alt={alt}
                style={{
                  maxWidth: '100%',
                  borderRadius: 'var(--ns-radius-xs)',
                  border: '1px solid var(--border-dim)',
                  margin: '2rem 0',
                }}
                {...props}
              />
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
