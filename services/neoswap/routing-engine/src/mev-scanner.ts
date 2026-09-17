import type { MEVScanResult, SwapRoute } from './types';

/**
 * MEV (Maximal Extractable Value) Risk Scanner
 * Detects potential front-running, sandwich attacks, and other MEV patterns
 */

export class MEVRiskScanner {
  private knownBots: Set<string> = new Set();
  private suspiciousPatterns: Map<string, number> = new Map();

  async scanRoute(route: SwapRoute, txContext?: TransactionContext): Promise<MEVScanResult> {
    const patterns: string[] = [];
    let riskScore = 0;

    // Pattern 1: High price impact detection
    if (route.priceImpact > 2.0) {
      patterns.push('HIGH_PRICE_IMPACT');
      riskScore += 30;
    }

    // Pattern 2: Unusual slippage requirements
    if (txContext?.slippage && txContext.slippage > 10) {
      patterns.push('EXCESSIVE_SLIPPAGE');
      riskScore += 20;
    }

    // Pattern 3: Gas bidding anomalies
    if (
      txContext?.gasPrice &&
      txContext.baseGasPrice !== undefined &&
      txContext.gasPrice > 2 * txContext.baseGasPrice
    ) {
      patterns.push('PRIORITY_FEE_ANOMALY');
      riskScore += 25;
    }

    // Pattern 4: Route complexity analysis
    if (route.poolPath.length > 3) {
      patterns.push('COMPLEX_MULTIHOP');
      riskScore += 10;
    }

    // Pattern 5: Liquidity depth check
    const liquidityCheck = await this.checkLiquidityDepth(route);
    if (!liquidityCheck.sufficient) {
      patterns.push(...liquidityCheck.reasons);
      riskScore += 35;
    }

    // Pattern 6: Known bot address detection
    if (txContext?.sender && this.knownBots.has(txContext.sender.toLowerCase())) {
      patterns.push('KNOWN_BOT_ACTIVITY');
      riskScore += 40;
    }

    // Determine risk level
    let riskLevel: 'low' | 'medium' | 'high' = 'low';
    if (riskScore >= 50) riskLevel = 'high';
    else if (riskScore >= 25) riskLevel = 'medium';

    return {
      isSuspicious: riskScore > 20,
      riskLevel,
      detectedPatterns: patterns,
      suggestedSlippage: this.calculateSuggestedSlippage(route, patterns),
    };
  }

  private calculateSuggestedSlippage(route: SwapRoute, patterns: string[]): number {
    let baseSlippage = 0.5; // 0.5% default

    // Add slippage buffer for each detected pattern
    baseSlippage += patterns.length * 0.5;

    // Increase significantly for high price impact
    if (route.priceImpact > 5.0) {
      baseSlippage += 5.0;
    }

    return Math.min(baseSlippage, 20.0); // Cap at 20%
  }

  private async checkLiquidityDepth(route: SwapRoute): Promise<{
    sufficient: boolean;
    reasons: string[];
  }> {
    const reasons: string[] = [];

    // A route does not carry the reserve snapshot, so a fabricated TVL must
    // never be used to claim that depth was checked. Price impact is the
    // conservative signal available at this layer.
    if (!Number.isFinite(route.priceImpact) || route.priceImpact >= 10) {
      reasons.push('INSUFFICIENT_LIQUIDITY_EVIDENCE');
    }

    return { sufficient: reasons.length === 0, reasons };
  }

  registerKnownBot(address: string): void {
    this.knownBots.add(address.toLowerCase());
  }

  detectSandwichOpportunity(
    mempoolTx: MempoolTransaction,
    pendingSwaps: MempoolTransaction[]
  ): SandwichOpportunity | null {
    // Look for large swaps that can be sandwiched
    const targetTx = pendingSwaps.find(
      (tx) => tx.amountUsd > mempoolTx.amountUsd * 2 // Target should be 2x larger
    );

    if (!targetTx) return null;

    const profitEstimate = this.estimateSandwichProfit(mempoolTx, targetTx);

    return {
      opportunity: true,
      targetTx: targetTx.hash,
      buyTransaction: this.constructBuyTx(mempoolTx),
      sellTransaction: this.constructSellTx(targetTx),
      estimatedProfit: profitEstimate,
      gasCost: this.estimateGasCost(),
    };
  }

  private estimateSandwichProfit(
    buyerTx: MempoolTransaction,
    targetTx: MempoolTransaction
  ): number {
    // Simplified profit estimation
    const tokenPrice = 1.0;
    const priceMove = targetTx.amountUsd / 1000000; // $10M pool
    const profit = targetTx.amountUsd * priceMove * 0.995; // 0.5% fee

    return profit * tokenPrice;
  }

  private constructBuyTx(tx: MempoolTransaction): BuyTransaction {
    return {
      to: tx.tokenAddress,
      data: tx.calldata,
      value: tx.amount,
      gasLimit: 500000,
    };
  }

  private constructSellTx(tx: MempoolTransaction): SellTransaction {
    return {
      to: tx.tokenAddress,
      data: tx.calldata,
      value: tx.amount,
      gasLimit: 500000,
    };
  }

  private estimateGasCost(): number {
    return 0.002 * 2000; // 2 transactions * 2000 gwei * $/gwei
  }
}

// Type definitions for MEV scanning
interface TransactionContext {
  sender?: string;
  slippage?: number;
  gasPrice?: number;
  baseGasPrice?: number;
}

interface MempoolTransaction {
  hash: string;
  sender: string;
  amount: string;
  amountUsd: number;
  tokenAddress: string;
  calldata: string;
  timestamp: number;
}

interface SandwichOpportunity {
  opportunity: boolean;
  targetTx: string;
  buyTransaction: BuyTransaction;
  sellTransaction: SellTransaction;
  estimatedProfit: number;
  gasCost: number;
}

interface BuyTransaction {
  to: string;
  data: string;
  value: string;
  gasLimit: number;
}

interface SellTransaction extends BuyTransaction {}
