'use client';

type SnippetIssuesBannerProps = {
  issues: string[];
};

export function SnippetIssuesBanner({ issues }: SnippetIssuesBannerProps) {
  return (
    <div
      role="status"
      style={{
        padding: '1rem',
        background: 'rgba(245, 158, 11, 0.08)',
        border: '1px solid rgba(245, 158, 11, 0.25)',
        color: '#fcd34d',
        fontSize: '0.85rem',
        lineHeight: 1.7,
      }}
    >
      {issues.map((issue) => (
        <div key={issue}>{issue}</div>
      ))}
    </div>
  );
}
