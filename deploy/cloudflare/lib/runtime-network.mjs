export function runtimeNetworkRefusal(pathname) {
  let path;
  try {
    path = decodeURIComponent(pathname);
  } catch {
    return Response.json({ error: 'invalid_runtime_path' }, { status: 400 });
  }
  // Every ingress to this origin must enforce its enclave's actual network.
  const network = path.split(/[\\/]/).filter(Boolean)[0]?.toLowerCase();
  if (network === 'testnet') {
    return Response.json(
      {
        error: 'runtime_network_mismatch',
        requested_network: 'testnet',
        actual_network: 'mainnet',
      },
      { status: 503, headers: { 'cache-control': 'no-store' } }
    );
  }
  return null;
}
