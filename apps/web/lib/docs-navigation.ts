export type DocsNavigationIcon =
  | 'activity'
  | 'book'
  | 'boxes'
  | 'briefcase'
  | 'check-circle'
  | 'clipboard-list'
  | 'code'
  | 'cpu'
  | 'fingerprint'
  | 'help-circle'
  | 'layers'
  | 'line-chart'
  | 'shield'
  | 'zap';

export type DocsNavigationItem = {
  readonly href: string;
  readonly label: string;
  readonly icon: DocsNavigationIcon;
};

export type DocsNavigationSection = {
  readonly title: string;
  readonly items: readonly DocsNavigationItem[];
};

export const DOCS_NAVIGATION_SECTIONS = [
  {
    title: 'Fundamentals',
    items: [
      { href: '/docs', label: 'Introduction', icon: 'book' },
      { href: '/docs/architecture', label: 'Architecture', icon: 'layers' },
    ],
  },
  {
    title: 'Guides',
    items: [
      { href: '/docs/quickstart', label: 'Quickstart', icon: 'zap' },
      { href: '/docs/launchpad', label: 'Launchpad', icon: 'boxes' },
      { href: '/docs/use-cases', label: 'Use Cases', icon: 'briefcase' },
      { href: '/docs/templates', label: 'Starter Templates', icon: 'clipboard-list' },
      { href: '/docs/studio', label: 'Starter Studio', icon: 'boxes' },
      { href: '/docs/neodid', label: 'NeoDID', icon: 'fingerprint' },
      { href: '/docs/r/NEODID_DID_METHOD', label: 'NeoDID DID Method', icon: 'fingerprint' },
      { href: '/docs/r/AA_SOCIAL_RECOVERY', label: 'AA Social Recovery', icon: 'shield' },
      { href: '/docs/oracle', label: 'Privacy Oracle', icon: 'shield' },
      { href: '/docs/compute', label: 'Enclave Compute', icon: 'cpu' },
      { href: '/docs/datafeeds', label: 'Datafeeds', icon: 'line-chart' },
      { href: '/docs/feed-status', label: 'Feed Status', icon: 'activity' },
      { href: '/docs/r/USER_GUIDE', label: 'User Guide', icon: 'book' },
    ],
  },
  {
    title: 'Reference',
    items: [
      { href: '/docs/networks', label: 'Networks & Contracts', icon: 'layers' },
      { href: '/docs/api-reference', label: 'API Reference', icon: 'code' },
      { href: '/docs/verifier', label: 'Verifier Guide', icon: 'check-circle' },
      { href: '/docs/faq', label: 'FAQ & Troubleshooting', icon: 'help-circle' },
    ],
  },
  {
    title: 'Extended Documentation',
    items: [
      { href: '/docs/r/EXAMPLES', label: 'Examples Portfolio', icon: 'code' },
      { href: '/docs/r/BUILTIN_COMPUTE', label: 'Built-in Compute', icon: 'cpu' },
      { href: '/docs/r/PROVIDERS', label: 'Supported Providers', icon: 'boxes' },
      { href: '/docs/r/DEPLOYMENT', label: 'Deployment', icon: 'boxes' },
      { href: '/docs/r/ENVIRONMENT', label: 'Environment Setup', icon: 'zap' },
      { href: '/docs/r/OPERATIONS', label: 'Operations', icon: 'activity' },
      { href: '/docs/r/VALIDATION', label: 'Validation', icon: 'check-circle' },
      { href: '/docs/r/PAYMASTER', label: 'Paymaster', icon: 'check-circle' },
      { href: '/docs/r/RELAYER', label: 'Relayer', icon: 'activity' },
      { href: '/docs/r/ASYNC_PRIVACY_ORACLE_SPEC', label: 'Async Privacy Spec', icon: 'shield' },
      { href: '/docs/r/ATTESTATION_SPEC', label: 'Attestation Spec', icon: 'check-circle' },
      { href: '/docs/r/SAAS_STACK_INTEGRATION', label: 'SaaS Stack', icon: 'boxes' },
      { href: '/docs/r/SECURITY_AUDIT', label: 'Security Audit', icon: 'shield' },
    ],
  },
] as const satisfies readonly DocsNavigationSection[];

export function flattenDocsNavigation(
  sections: readonly DocsNavigationSection[] = DOCS_NAVIGATION_SECTIONS
) {
  return sections.flatMap((section) => section.items);
}
