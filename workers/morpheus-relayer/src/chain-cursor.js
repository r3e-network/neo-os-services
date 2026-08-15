export function getRequestCursorFloor(config, chain) {
  const raw = Number(config.startRequestIds?.[chain]);
  return Number.isFinite(raw) && raw > 0 ? raw : null;
}

export function pruneRetryQueueBelowRequestFloor(state, chain, minRequestId) {
  if (minRequestId === null) return 0;
  const before = state[chain].retry_queue.length;
  state[chain].retry_queue = state[chain].retry_queue.filter((item) => {
    const requestId = Number(item?.event?.requestId || 0);
    return !Number.isFinite(requestId) || requestId >= minRequestId;
  });
  return before - state[chain].retry_queue.length;
}

export function resolveChainFromBlock(config, state, chain, confirmedTip, logger = null) {
  const configuredStart = config.startBlocks[chain];
  const defaultStart = Math.max(configuredStart ?? 0, 0);
  const lastBlockRaw = state[chain].last_block;

  if (lastBlockRaw === null || lastBlockRaw === undefined) {
    return defaultStart;
  }

  const lastBlock = Number(lastBlockRaw);
  if (!Number.isFinite(lastBlock) || lastBlock < -1) {
    logger?.error?.(
      {
        chain,
        invalid_checkpoint: lastBlockRaw,
        start_block: defaultStart,
      },
      'Relayer checkpoint is invalid; refusing to silently reset to genesis'
    );
    throw new Error(
      `Invalid relayer checkpoint for ${chain}: ${JSON.stringify(lastBlockRaw)}. Refusing to reset to genesis (${defaultStart}).`
    );
  }

  if (lastBlock > confirmedTip) {
    logger?.error?.(
      {
        chain,
        checkpoint: lastBlock,
        confirmed_tip: confirmedTip,
        start_block: defaultStart,
      },
      'Relayer checkpoint is ahead of confirmed tip; refusing to silently reset to genesis'
    );
    throw new Error(
      `Relayer checkpoint for ${chain} (${lastBlock}) is ahead of the confirmed tip (${confirmedTip}). Refusing to reset to genesis (${defaultStart}).`
    );
  }

  return lastBlock + 1;
}
