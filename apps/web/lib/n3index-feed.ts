export function buildN3IndexFeedNotificationUrl(
  network: 'mainnet' | 'testnet',
  _contractHash = '',
  limit = 100
) {
  const params = new URLSearchParams({
    network: `eq.${network}`,
    event_name: 'eq.FeedUpdated',
    limit: String(Math.max(Math.min(limit, 500), 1)),
    order: 'block_index.desc',
  });
  return `https://api.n3index.dev/rest/v1/contract_notifications?${params.toString()}`;
}
