export interface AnchorCandidateObservation {
  id: string;
  rewardPerNeo: number;
  feeBps?: number;
  observedAt: number;
}
export interface AnchorRebalancePlan {
  network: 'mainnet' | 'testnet';
  appId: string;
  observationBlock: number;
  targetCandidateId: string;
  targetNetRewardPerNeo: number;
  improvementBps: number;
  /** Uncapped exact basis-point ratio; improvementBps is capped for numeric display. */
  improvementBpsExact: string;
  action: 'vote-agent' | 'no-op';
  idempotencyKey: string;
  rankedCandidates: Array<AnchorCandidateObservation & { feeBps: number; netReward: number }>;
}
export declare function rankAnchorCandidates(candidates: AnchorCandidateObservation[], options?: { nowMs?: number; maxAgeMs?: number }): Array<AnchorCandidateObservation & { feeBps: number; netReward: number }>;
export declare function createAnchorRebalancePlan(input: { network: 'mainnet' | 'testnet'; appId: 'miniapp-profitanchor'; currentAgentId?: string | null; observationBlock: number; candidates: AnchorCandidateObservation[] }, options?: { nowMs?: number; maxAgeMs?: number; minImprovementBps?: number }): AnchorRebalancePlan;
export declare const DEFAULT_MAX_AGE_MS: number;
export declare const MAX_CANDIDATES: number;
