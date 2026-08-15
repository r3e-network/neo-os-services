import './globals.css';
import type { ReactNode } from 'react';
import type { Viewport } from 'next';
import { ToastProvider } from '@/components/ui/Toast';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { Layout } from '@/components/ui/Layout';

import { resolveMetadataBase } from '@/lib/app-url';

const metadataBase = resolveMetadataBase(process.env.NEXT_PUBLIC_APP_URL);

export const metadata = {
  metadataBase,
  title: {
    default: 'NeoOS Services',
    template: '%s | NeoOS Services',
  },
  description: 'Confidential oracle, compute, and isolated datafeed infrastructure for Neo N3.',
  icons: {
    icon: '/logo.png',
  },
  openGraph: {
    title: 'NeoOS Services',
    description: 'Confidential oracle infrastructure for Neo N3.',
    images: ['/og-card.webp'],
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <ErrorBoundary>
          <ToastProvider>
            <Layout>{children}</Layout>
          </ToastProvider>
        </ErrorBoundary>
      </body>
    </html>
  );
}
