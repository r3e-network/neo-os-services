import { Skeleton, SkeletonStats, SkeletonGrid } from '@/components/ui/Skeleton';

export default function ExplorerLoading() {
  return (
    <div className="container" style={{ padding: 'calc(72px + 2rem) 0 3rem' }}>
      <div
        style={{
          marginBottom: '2rem',
          paddingBottom: '1.5rem',
          borderBottom: '1px solid var(--border-dim)',
        }}
      >
        <Skeleton width="200px" height="14px" style={{ marginBottom: '0.9rem' }} />
        <Skeleton width="140px" height="36px" style={{ marginBottom: '0.75rem' }} />
        <Skeleton width="500px" height="18px" style={{ marginBottom: '1rem' }} />
        <div style={{ display: 'flex', gap: '0.75rem' }}>
          <Skeleton width="180px" height="40px" />
          <Skeleton width="140px" height="40px" />
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '260px 1fr', gap: '3rem' }}>
        <div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <Skeleton key={i} height="58px" style={{ borderRadius: 'var(--ns-radius-md)' }} />
            ))}
          </div>
        </div>
        <div>
          <SkeletonStats />
          <div style={{ marginTop: '2rem' }}>
            <SkeletonGrid count={6} />
          </div>
        </div>
      </div>
    </div>
  );
}
