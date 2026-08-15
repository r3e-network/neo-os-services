'use client';

import { useState } from 'react';
import { Copy, Check, ChevronDown, ChevronUp } from 'lucide-react';
import Link from 'next/link';

import hljs from 'highlight.js';
import 'highlight.js/styles/github.css';

interface CodeBlockProps {
  code: string;
  language?: string;
  title?: string;
  showLineNumbers?: boolean;
  maxHeight?: string;
  collapsible?: boolean;
}

export function CodeBlock({
  code,
  language = 'plaintext',
  title,
  showLineNumbers = false,
  maxHeight,
  collapsible = false,
}: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [isExpanded, setIsExpanded] = useState(true);

  const writeToClipboard = async (text: string): Promise<boolean> => {
    // The async Clipboard API is only available in secure contexts (HTTPS or
    // localhost). On http:// previews `navigator.clipboard` is undefined, so
    // fall back to a hidden-textarea + execCommand copy before giving up.
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        // fall through to the legacy path
      }
    }
    if (typeof document === 'undefined') return false;
    try {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      textarea.style.pointerEvents = 'none';
      document.body.appendChild(textarea);
      textarea.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(textarea);
      return ok;
    } catch {
      return false;
    }
  };

  const handleCopy = async () => {
    const ok = await writeToClipboard(code);
    if (ok) {
      setCopyFailed(false);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } else {
      setCopied(false);
      setCopyFailed(true);
      setTimeout(() => setCopyFailed(false), 2000);
    }
  };

  const validLanguage = hljs.getLanguage(language) ? language : 'plaintext';
  const highlighted = hljs.highlight(code, { language: validLanguage }).value;

  const lines = code.split('\n');

  return (
    <div
      style={{
        position: 'relative',
        margin: '1.5rem 0',
        borderRadius: 'var(--ns-radius-sm)',
        overflow: 'hidden',
        maxWidth: '100%',
        minWidth: 0,
        border: '1px solid var(--border-dim)',
        background: 'var(--bg-code)',
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '0.5rem 1rem',
          background: '#f8fbff',
          borderBottom: '1px solid var(--border-dim)',
          gap: '1rem',
          minWidth: 0,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            minWidth: 0,
          }}
        >
          <span
            style={{
              fontSize: '0.65rem',
              color: 'var(--text-secondary)',
              fontFamily: 'var(--font-mono)',
              textTransform: 'uppercase',
              letterSpacing: 0,
              flexShrink: 0,
            }}
          >
            {language}
          </span>
          {title && (
            <span
              style={{
                fontSize: '0.75rem',
                color: 'var(--text-muted)',
                fontFamily: 'var(--font-mono)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {title}
            </span>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
          {collapsible && lines.length > 10 && (
            <button
              onClick={() => setIsExpanded(!isExpanded)}
              style={{
                background: 'transparent',
                border: 'none',
                color: 'var(--text-secondary)',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '4px',
                fontSize: '0.7rem',
                fontFamily: 'var(--font-mono)',
                padding: '4px 8px',
                borderRadius: 'var(--ns-radius-xs)',
                transition: 'all 0.2s',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = 'var(--text-primary)';
                e.currentTarget.style.background = 'rgba(83, 58, 253, 0.07)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = 'var(--text-secondary)';
                e.currentTarget.style.background = 'transparent';
              }}
            >
              {isExpanded ? (
                <>
                  <ChevronUp size={12} /> Collapse
                </>
              ) : (
                <>
                  <ChevronDown size={12} /> Expand ({lines.length} lines)
                </>
              )}
            </button>
          )}
          <button
            onClick={handleCopy}
            style={{
              background: 'transparent',
              border: 'none',
              color: copied
                ? 'var(--neo-green)'
                : copyFailed
                  ? 'var(--ns-danger, #d92d20)'
                  : 'var(--text-secondary)',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              fontSize: '0.7rem',
              fontFamily: 'var(--font-mono)',
              padding: '4px 8px',
              borderRadius: 'var(--ns-radius-xs)',
              transition: 'all 0.2s',
            }}
            title={copyFailed ? 'Copy failed — select and copy manually' : 'Copy code'}
            onMouseEnter={(e) => {
              if (!copied && !copyFailed) {
                e.currentTarget.style.color = 'var(--text-primary)';
                e.currentTarget.style.background = 'rgba(83, 58, 253, 0.07)';
              }
            }}
            onMouseLeave={(e) => {
              if (!copied && !copyFailed) {
                e.currentTarget.style.color = 'var(--text-secondary)';
                e.currentTarget.style.background = 'transparent';
              }
            }}
          >
            {copied ? (
              <>
                <Check size={12} /> Copied
              </>
            ) : copyFailed ? (
              <>
                <Copy size={12} /> Copy failed
              </>
            ) : (
              <>
                <Copy size={12} /> Copy
              </>
            )}
          </button>
        </div>
      </div>
      <div
        style={{
          overflowX: 'auto',
          maxHeight: isExpanded ? maxHeight || 'none' : 'none',
          overflowY: isExpanded ? 'auto' : 'hidden',
          maxWidth: '100%',
          minWidth: 0,
        }}
      >
        <table
          style={{
            width: '100%',
            borderCollapse: 'collapse',
            background: 'transparent',
          }}
        >
          <tbody>
            <tr>
              {showLineNumbers && (
                <td
                  style={{
                    padding: '1rem 0 1rem 1rem',
                    textAlign: 'right',
                    verticalAlign: 'top',
                    userSelect: 'none',
                    color: '#8b949e',
                    fontSize: '0.75rem',
                    fontFamily: 'var(--font-mono)',
                    borderRight: '1px solid var(--border-dim)',
                    paddingRight: '12px',
                    width: '1%',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {lines.map((_, i) => (
                    <div key={i} style={{ lineHeight: '1.6' }}>
                      {i + 1}
                    </div>
                  ))}
                </td>
              )}
              <td
                style={{
                  padding: '1rem',
                  verticalAlign: 'top',
                }}
              >
                <pre
                  style={{
                    margin: 0,
                    background: 'transparent',
                    padding: 0,
                    border: 'none',
                    whiteSpace: 'pre-wrap',
                    overflowWrap: 'anywhere',
                  }}
                >
                  <code
                    className={`hljs language-${validLanguage}`}
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: '0.8rem',
                      lineHeight: '1.6',
                      background: 'transparent',
                      padding: 0,
                      color: 'var(--text-primary)',
                      whiteSpace: 'pre-wrap',
                      overflowWrap: 'anywhere',
                    }}
                    dangerouslySetInnerHTML={{ __html: highlighted }}
                  />
                </pre>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface BreadcrumbItem {
  label: string;
  href?: string;
}

interface BreadcrumbsProps {
  items: BreadcrumbItem[];
}

export function Breadcrumbs({ items }: BreadcrumbsProps) {
  return (
    <nav
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '4px',
        marginBottom: '1.5rem',
        fontSize: '0.8rem',
        fontFamily: 'var(--font-mono)',
      }}
      aria-label="Breadcrumb"
    >
      {items.map((item, index) => {
        const isLast = index === items.length - 1;
        return (
          <span
            key={index}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
            }}
          >
            {index > 0 && <span style={{ color: 'var(--text-muted)' }}>/</span>}
            {item.href && !isLast ? (
              <Link
                href={item.href}
                style={{
                  color: 'var(--text-secondary)',
                  textDecoration: 'none',
                  transition: 'color 0.2s',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.color = 'var(--neo-green)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.color = 'var(--text-secondary)';
                }}
              >
                {item.label}
              </Link>
            ) : (
              <span
                style={{
                  color: isLast ? 'var(--text-primary)' : 'var(--text-secondary)',
                  fontWeight: isLast ? 600 : 400,
                }}
              >
                {item.label}
              </span>
            )}
          </span>
        );
      })}
    </nav>
  );
}
