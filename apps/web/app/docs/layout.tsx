'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ReactNode, useState } from 'react';
import {
  Activity,
  ArrowLeft,
  Book,
  Boxes,
  Briefcase,
  CheckCircle,
  ChevronRight,
  ClipboardList,
  Code2,
  Cpu,
  Fingerprint,
  Github,
  HelpCircle,
  Layers,
  LineChart,
  Menu,
  Shield,
  X,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import {
  DOCS_NAVIGATION_SECTIONS,
  flattenDocsNavigation,
  type DocsNavigationIcon,
} from '@/lib/docs-navigation';

const docsNavigationIcons: Record<DocsNavigationIcon, LucideIcon> = {
  activity: Activity,
  book: Book,
  boxes: Boxes,
  briefcase: Briefcase,
  'check-circle': CheckCircle,
  'clipboard-list': ClipboardList,
  code: Code2,
  cpu: Cpu,
  fingerprint: Fingerprint,
  'help-circle': HelpCircle,
  layers: Layers,
  'line-chart': LineChart,
  shield: Shield,
  zap: Zap,
};

export default function DocsLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const sections = DOCS_NAVIGATION_SECTIONS;

  return (
    <div className="min-h-screen flex flex-col relative">
      <div className="bg-grid"></div>

      {/* Mobile sidebar toggle */}
      <button
        className="show-mobile"
        onClick={() => setIsSidebarOpen(!isSidebarOpen)}
        style={{
          position: 'fixed',
          top: '96px',
          left: '12px',
          zIndex: 999,
          background: 'var(--bg-card)',
          border: '1px solid var(--border-dim)',
          borderRadius: 'var(--ns-radius-sm)',
          boxShadow: 'var(--ns-shadow-sm)',
          padding: '0.5rem',
          color: 'var(--text-primary)',
          cursor: 'pointer',
        }}
      >
        {isSidebarOpen ? <X size={18} /> : <Menu size={18} />}
      </button>

      <div
        className="container flex-1"
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          padding: '0',
          maxWidth: '1440px',
          margin: '0 auto',
          paddingTop: '72px',
        }}
      >
        {/* Docs Sidebar */}
        <aside
          className={`docs-sidebar ${isSidebarOpen ? 'open' : ''}`}
          style={{
            width: '280px',
            flexShrink: 0,
            position: 'sticky',
            top: '72px',
            height: 'calc(100vh - 72px)',
            overflowY: 'auto',
            borderRight: '1px solid var(--border-dim)',
            padding: '2.5rem 1.5rem',
            background: 'var(--bg-main)',
            zIndex: 900,
          }}
        >
          {sections.map((section, idx) => (
            <div key={idx} style={{ marginBottom: '2.5rem' }}>
              <span
                style={{
                  fontSize: '0.65rem',
                  fontWeight: 800,
                  color: 'var(--text-secondary)',
                  textTransform: 'uppercase',
                  letterSpacing: 0,
                  fontFamily: 'var(--font-mono)',
                  paddingLeft: '1rem',
                  display: 'block',
                  marginBottom: '1rem',
                }}
              >
                {section.title}
              </span>
              <nav style={{ display: 'flex', flexDirection: 'column', gap: '0.15rem' }}>
                {section.items.map((item) => {
                  const Icon = docsNavigationIcons[item.icon];
                  const isActive = pathname === item.href;
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      onClick={() => setIsSidebarOpen(false)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '10px',
                        padding: '0.65rem 1rem',
                        borderRadius: 'var(--ns-radius-xs)',
                        color: isActive ? 'var(--neo-green)' : 'var(--text-secondary)',
                        background: isActive ? 'var(--neo-green-dim)' : 'transparent',
                        fontWeight: isActive ? 700 : 500,
                        fontSize: '0.85rem',
                        transition: 'all 0.2s',
                        textDecoration: 'none',
                        borderLeft: isActive
                          ? '2px solid var(--neo-green)'
                          : '2px solid transparent',
                      }}
                    >
                      <Icon size={14} color={isActive ? 'var(--neo-green)' : 'currentColor'} />
                      <span style={{ flex: 1 }}>{item.label}</span>
                    </Link>
                  );
                })}
              </nav>
            </div>
          ))}

          <div
            style={{
              marginTop: '2rem',
              padding: '1.25rem',
              background: 'rgba(83, 58, 253, 0.045)',
              border: '1px solid var(--border-dim)',
              borderRadius: 'var(--ns-radius-md)',
            }}
          >
            <h4
              style={{
                fontSize: '0.65rem',
                fontWeight: 800,
                marginBottom: '0.5rem',
                color: 'var(--text-primary)',
                textTransform: 'uppercase',
              }}
            >
              Resources
            </h4>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              <a
                href="https://github.com/r3e-network/neo-os-services"
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  fontSize: '0.75rem',
                  color: 'var(--text-secondary)',
                  textDecoration: 'none',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                }}
                className="hover-link"
              >
                <Github size={12} /> Source Code
              </a>
              <a
                href="https://github.com/r3e-network/neo-os-services/issues"
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  fontSize: '0.75rem',
                  color: 'var(--text-secondary)',
                  textDecoration: 'none',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                }}
                className="hover-link"
              >
                <HelpCircle size={12} /> Support
              </a>
            </div>
          </div>
        </aside>

        {/* Main Content */}
        <main
          className="docs-content fade-up"
          style={{ flex: 1, padding: '4rem 6rem', minWidth: 0, width: '100%' }}
        >
          <div className="docs-content-inner" style={{ maxWidth: '840px' }}>
            {children}

            {/* Next/Prev Navigation */}
            {(() => {
              const flatItems = flattenDocsNavigation(sections);
              const currentIndex = flatItems.findIndex((i) => i.href === pathname);
              const prevItem = currentIndex > 0 ? flatItems[currentIndex - 1] : null;
              const nextItem =
                currentIndex !== -1 && currentIndex < flatItems.length - 1
                  ? flatItems[currentIndex + 1]
                  : null;

              if (!prevItem && !nextItem) return null;

              return (
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '1fr 1fr',
                    gap: '2rem',
                    marginTop: '4rem',
                  }}
                >
                  {prevItem ? (
                    <Link
                      href={prevItem.href}
                      className="card-industrial"
                      style={{
                        padding: '1.5rem',
                        textDecoration: 'none',
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'flex-start',
                        transition: 'border-color 0.2s',
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.borderColor = 'var(--neo-green)')}
                      onMouseLeave={(e) =>
                        (e.currentTarget.style.borderColor = 'var(--border-dim)')
                      }
                    >
                      <span
                        style={{
                          fontSize: '0.65rem',
                          color: 'var(--text-muted)',
                          fontWeight: 800,
                          textTransform: 'uppercase',
                          letterSpacing: 0,
                          marginBottom: '0.5rem',
                        }}
                      >
                        Previous
                      </span>
                      <span
                        style={{
                          fontSize: '1rem',
                          color: 'var(--text-primary)',
                          fontWeight: 700,
                          display: 'flex',
                          alignItems: 'center',
                          gap: '8px',
                        }}
                      >
                        <ArrowLeft size={16} color="var(--neo-green)" /> {prevItem.label}
                      </span>
                    </Link>
                  ) : (
                    <div></div>
                  )}

                  {nextItem ? (
                    <Link
                      href={nextItem.href}
                      className="card-industrial"
                      style={{
                        padding: '1.5rem',
                        textDecoration: 'none',
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'flex-end',
                        transition: 'border-color 0.2s',
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.borderColor = 'var(--neo-green)')}
                      onMouseLeave={(e) =>
                        (e.currentTarget.style.borderColor = 'var(--border-dim)')
                      }
                    >
                      <span
                        style={{
                          fontSize: '0.65rem',
                          color: 'var(--text-muted)',
                          fontWeight: 800,
                          textTransform: 'uppercase',
                          letterSpacing: 0,
                          marginBottom: '0.5rem',
                        }}
                      >
                        Next
                      </span>
                      <span
                        style={{
                          fontSize: '1rem',
                          color: 'var(--text-primary)',
                          fontWeight: 700,
                          display: 'flex',
                          alignItems: 'center',
                          gap: '8px',
                        }}
                      >
                        {nextItem.label} <ChevronRight size={16} color="var(--neo-green)" />
                      </span>
                    </Link>
                  ) : (
                    <div></div>
                  )}
                </div>
              );
            })()}

            {/* Footer Navigation */}
            <div
              style={{
                marginTop: '4rem',
                paddingTop: '3rem',
                borderTop: '1px solid var(--border-dim)',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                <span
                  style={{
                    fontSize: '0.6rem',
                    color: 'var(--text-muted)',
                    fontWeight: 800,
                    letterSpacing: 0,
                  }}
                >
                  CURRENT DESIGN
                </span>
                <span
                  style={{
                    fontSize: '0.75rem',
                    color: 'var(--text-dim)',
                    fontFamily: 'var(--font-mono)',
                  }}
                >
                  UPDATED FOR DUAL-CVM ARCHITECTURE
                </span>
              </div>
              <div>
                <a
                  href="https://github.com/r3e-network/neo-os-services"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn btn-secondary btn-sm"
                  style={{ fontSize: '0.7rem' }}
                >
                  <Github size={14} /> EDIT ON GITHUB
                </a>
              </div>
            </div>
          </div>
        </main>
      </div>

      <style>{`
 .docs-sidebar::-webkit-scrollbar { width: 3px; }
 .docs-sidebar::-webkit-scrollbar-thumb { background: var(--border-dim); }

 .hover-link:hover { color: var(--neo-green) !important; }

 @media (max-width: 1024px) {
 .docs-sidebar {
 position: fixed !important;
 left: 0;
 top: 72px;
 bottom: 0;
 width: min(320px, 86vw) !important;
 height: calc(100vh - 72px) !important;
 transform: translateX(-100%);
 transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1);
 background: var(--bg-card);
 box-shadow: 20px 0 50px rgba(50,50,93,0.18);
 }
 .docs-sidebar.open {
 transform: translateX(0);
 }
	 .docs-content {
	 padding: 6rem 1rem 2rem !important;
	 width: 100% !important;
	 max-width: 100vw !important;
	 box-sizing: border-box;
	 overflow-x: hidden;
	 }
 .docs-content-inner {
 max-width: 100% !important;
 width: 100%;
 }
 .docs-content p,
 .docs-content li,
 .docs-content blockquote,
 .docs-content table,
 .docs-content code {
 overflow-wrap: anywhere;
 word-break: break-word;
 }
 .docs-content h1 {
 font-size: clamp(2rem, 11vw, 2.65rem);
 }
 .hide-mobile { display: none; }
 }
 @media (min-width: 1025px) {
 .show-mobile { display: none; }
 }
 `}</style>
    </div>
  );
}
