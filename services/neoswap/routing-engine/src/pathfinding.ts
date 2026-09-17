import BigNumber from 'bignumber.js';
import type { SwapRoute } from './types';

type RoutingPool = {
  id: string;
  tokenIn: string;
  tokenOut: string;
  liquidity?: string;
  feeTier?: number;
  reserveIn: string;
  reserveOut: string;
};

type PoolEdge = {
  token: string;
  poolId: string;
  reverse: boolean;
};

export class PathfindingEngine {
  private readonly adjacencyMatrix: Map<string, PoolEdge[]> = new Map();
  private readonly pools: Map<string, RoutingPool> = new Map();

  setPools(pools: RoutingPool[]): void {
    this.adjacencyMatrix.clear();
    this.pools.clear();
    for (const pool of pools) {
      if (!pool.id || !pool.tokenIn || !pool.tokenOut) continue;
      this.pools.set(pool.id, pool);
      this.addEdge(pool.tokenIn, { token: pool.tokenOut, poolId: pool.id, reverse: false });
      this.addEdge(pool.tokenOut, { token: pool.tokenIn, poolId: pool.id, reverse: true });
    }
  }

  private addEdge(from: string, edge: PoolEdge): void {
    const edges = this.adjacencyMatrix.get(from) ?? [];
    edges.push(edge);
    this.adjacencyMatrix.set(from, edges);
  }

  // Floyd-Warshall algorithm for multi-hop pathfinding
  findBestRoutes(tokenIn: string, tokenOut: string, amount: string, maxHops = 4): SwapRoute[] {
    if (
      tokenIn === tokenOut ||
      !new BigNumber(amount).isFinite() ||
      new BigNumber(amount).isLessThanOrEqualTo(0)
    ) {
      return [];
    }
    const routes: SwapRoute[] = [];

    // Find all paths using BFS with depth limiting
    const paths = this.bfsEdgePaths(tokenIn, tokenOut, Math.min(Math.max(maxHops, 1), 6));

    for (const path of paths) {
      const route = this.calculateRoute(path, amount);
      if (route) {
        routes.push(route);
      }
    }

    // Sort by expected output amount
    return routes.sort((a, b) => {
      return new BigNumber(b.outAmount).comparedTo(new BigNumber(a.outAmount)) ?? 0;
    });
  }

  private bfsEdgePaths(start: string, end: string, maxDepth = 5): PoolEdge[][] {
    const paths: PoolEdge[][] = [];
    const queue: Array<{ token: string; edges: PoolEdge[]; visited: Set<string> }> = [
      { token: start, edges: [], visited: new Set([start]) },
    ];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.token === end) {
        paths.push(current.edges);
        continue;
      }
      if (current.edges.length >= maxDepth) continue;
      for (const edge of this.adjacencyMatrix.get(current.token) ?? []) {
        if (current.visited.has(edge.token)) continue;
        queue.push({
          token: edge.token,
          edges: [...current.edges, edge],
          visited: new Set([...current.visited, edge.token]),
        });
      }
    }
    return paths;
  }

  private bfsPaths(start: string, end: string, maxDepth: number = 5): string[][] {
    const paths: string[][] = [];
    const queue: Array<{ path: string[]; depth: number }> = [{ path: [start], depth: 0 }];

    while (queue.length > 0) {
      const { path, depth } = queue.shift()!;
      const current = path[path.length - 1];

      if (current === end) {
        paths.push(path);
        continue;
      }

      if (depth < maxDepth) {
        const neighbors = this.getNeighbors(current);
        for (const neighbor of neighbors) {
          if (!path.includes(neighbor)) {
            queue.push({ path: [...path, neighbor], depth: depth + 1 });
          }
        }
      }
    }

    return paths;
  }

  private getNeighbors(node: string): string[] {
    const neighbors: string[] = [];
    for (const edge of this.adjacencyMatrix.get(node) ?? []) neighbors.push(edge.token);
    return neighbors;
  }

  private calculateRoute(path: PoolEdge[], amount: string): SwapRoute | null {
    let remainingAmount = new BigNumber(amount);

    for (const edge of path) {
      const pool = this.pools.get(edge.poolId);
      if (!pool) return null;

      // Calculate swap output based on constant product formula
      remainingAmount = this.calculatePoolOutput(pool, remainingAmount.toString(), edge.reverse);
    }

    const poolPath = path.map((edge) => edge.poolId);

    return {
      poolPath,
      inAmount: amount,
      outAmount: remainingAmount.toFixed(8),
      priceImpact: this.calculatePriceImpact(amount, remainingAmount.toFixed(8)),
      gasEstimate: `${poolPath.length * 50000}`, // ~50k gas per hop
      protocolFeeBps: 30, // 0.3%
    };
  }

  private calculatePoolOutput(pool: RoutingPool, inputAmount: string, reverse = false): BigNumber {
    // Constant product AMM formula: x * y = k
    // Given input amount and reserves, calculate output
    const reserveIn = new BigNumber(reverse ? pool.reserveOut : pool.reserveIn || '0');
    const reserveOut = new BigNumber(reverse ? pool.reserveIn : pool.reserveOut || '0');
    const amountIn = new BigNumber(inputAmount);

    if (reserveIn.isZero() || reserveOut.isZero()) {
      throw new Error('Pool has zero liquidity');
    }

    const fee = new BigNumber(pool.feeTier || 30);
    const amountInWithFee = amountIn.times(new BigNumber(10000).minus(fee));
    const numerator = amountInWithFee.times(reserveOut);
    const denominator = reserveIn.times(10000).plus(amountInWithFee);

    return numerator.div(denominator);
  }

  private calculatePriceImpact(inputAmount: string, outputAmount: string): number {
    const input = new BigNumber(inputAmount);
    const output = new BigNumber(outputAmount);

    // Simple price impact calculation
    const midPrice = this.getMidPrice();
    const impliedPrice = input.div(output);

    return impliedPrice.minus(midPrice).dividedBy(midPrice).abs().toNumber() * 100;
  }

  private getMidPrice(): BigNumber {
    // A neutral reference is used until a route-specific oracle price is supplied.
    // The caller still receives the pool-derived output and must apply slippage
    // limits before signing; this value is never used as a settlement price.
    return new BigNumber(1);
  }
}
