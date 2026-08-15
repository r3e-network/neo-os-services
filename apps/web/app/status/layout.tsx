import type { ReactNode } from 'react';

export const metadata = {
  title: 'System Status',
  description: 'Real-time health checks for NeoOS Oracle infrastructure services.',
};

export default function StatusLayout({ children }: { children: ReactNode }) {
  return children;
}
