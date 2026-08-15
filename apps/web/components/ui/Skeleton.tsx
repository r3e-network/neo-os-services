'use client';

import type { CSSProperties } from 'react';

type SkeletonProps = {
  width?: string | number;
  height?: string | number;
  borderRadius?: string | number;
  className?: string;
  style?: CSSProperties;
};

export function Skeleton({
  width = '100%',
  height = '20px',
  borderRadius = '8px',
  className = '',
  style,
}: SkeletonProps) {
  return (
    <div
      className={className}
      role="status"
      aria-busy="true"
      aria-label="Loading"
      style={{
        width: typeof width === 'number' ? `${width}px` : width,
        height: typeof height === 'number' ? `${height}px` : height,
        borderRadius: typeof borderRadius === 'number' ? `${borderRadius}px` : borderRadius,
        background:
          'linear-gradient(90deg, var(--border-dim) 25%, var(--border-highlight) 50%, var(--border-dim) 75%)',
        backgroundSize: '200% 100%',
        animation: 'shimmer 1.5s infinite',
        ...style,
      }}
    />
  );
}

export function SkeletonText({
  lines = 3,
  lastLineWidth = '60%',
}: {
  lines?: number;
  lastLineWidth?: string;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} width={i === lines - 1 ? lastLineWidth : '100%'} height="16px" />
      ))}
    </div>
  );
}

export function SkeletonCard() {
  return (
    <div
      style={{
        background: 'var(--bg-card)',
        border: '1px solid var(--border-dim)',
        borderRadius: 'var(--ns-radius-lg)',
        padding: '1.5rem',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '1rem' }}>
        <Skeleton width="60%" height="24px" />
        <Skeleton width="80px" height="20px" />
      </div>
      <SkeletonText lines={4} />
    </div>
  );
}

export function SkeletonGrid({ count = 6 }: { count?: number }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
        gap: '1px',
        background: 'var(--border-dim)',
      }}
    >
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          style={{
            background: 'var(--bg-card)',
            padding: '1.5rem',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '1rem' }}>
            <Skeleton width="50%" height="20px" />
            <Skeleton width="24px" height="24px" borderRadius="50%" />
          </div>
          <Skeleton width="80%" height="32px" />
          <div style={{ marginTop: '1rem' }}>
            <Skeleton width="40%" height="14px" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function SkeletonStats() {
  return (
    <div className="grid grid-3">
      {[1, 2, 3].map((i) => (
        <div
          key={i}
          style={{
            background: 'var(--bg-card)',
            border: '1px solid var(--border-dim)',
            borderRadius: 'var(--ns-radius-lg)',
            padding: '1.5rem',
          }}
        >
          <Skeleton width="40%" height="14px" />
          <div style={{ marginTop: '12px' }}>
            <Skeleton width="60%" height="28px" />
          </div>
        </div>
      ))}
    </div>
  );
}
