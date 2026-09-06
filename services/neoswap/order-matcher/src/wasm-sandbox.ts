import * as wasi from 'wasi';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

/**
 * WASM Sandbox for secure order matching logic execution
 * Provides isolation and deterministic computation
 */
export class WASMSandbox {
  private wasmModule?: WebAssembly.Module;
  private wasi?: wasi.WASI;
  private memory?: WebAssembly.Memory;
  
  constructor(wasmPath: string = './pkg/order_matcher.wasm') {
    this.loadWASM(wasmPath);
  }

  private async loadWASM(path: string): Promise<void> {
    try {
      const wasmBytes = readFileSync(path);
      this.wasmModule = await WebAssembly.compile(wasmBytes);
      
      // Initialize WASI
      this.wasi = new wasi.WASI({
        args: ['order-matcher'],
        env: {
          NEO_SWAP_MODE: process.env.NEO_SWAP_MODE || 'production',
          LOG_LEVEL: process.env.LOG_LEVEL || 'info',
        },
        print: (msg: string) => console.log('[WASM]', msg),
        stderr: (msg: string) => console.error('[WASM ERROR]', msg),
      });

      await this.wasi.initialize(this.wasmModule);
      console.log('WASM sandbox initialized successfully');
      
    } catch (error) {
      console.warn(`WASM sandbox initialization failed: ${error}, falling back to JS`);
    }
  }

  /**
   * Execute matching algorithm in WASM if available
   * Falls back to JavaScript implementation
   */
  executeMatchingAlgorithm(params: MatchingParams): MatchingResult {
    if (!this.wasmModule || !this.wasi) {
      console.log('Using fallback JS matching algorithm');
      return this.fallbackMatching(params);
    }

    try {
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();

      const input = JSON.stringify(params);
      const inputBuf = encoder.encode(input);

      // Allocate WASM memory
      if (!this.memory) {
        const exports = WebAssembly.instantiateSync(this.wasmModule, {
          env: {
            memory_base: 0,
            table_base: 0,
            memory: new WebAssembly.Memory({ initial: 256 }),
            table: new WebAssembly.Table({ initial: 0, element: 'anyfunc' }),
          },
        });
        this.memory = exports.instance.exports.memory as WebAssembly.Memory;
      }

      const memory = this.memory!;
      const inputPtr = this.allocateMemory(inputBuf);
      
      // Call WASM function (assuming export name: "match_orders")
      const resultPtr = (this.wasmModule.instance.exports.match_orders as (
        inputPtr: number,
        inputLen: number
      ) => number)(inputPtr, inputBuf.length);

      // Read result
      const resultBytes = new Uint8Array(memory.buffer, resultPtr);
      const output = decoder.decode(resultBytes);
      
      return JSON.parse(output);

    } catch (error) {
      console.error('WASM execution failed:', error);
      return this.fallbackMatching(params);
    }
  }

  private allocateMemory(data: Uint8Array): number {
    if (!this.memory) {
      throw new Error('Memory not initialized');
    }
    
    const ptr = this.memory.allocationSize;
    this.memory.buffer.slice(ptr, ptr + data.length);
    const view = new Uint8Array(this.memory.buffer);
    view.set(data);
    
    return ptr;
  }

  private fallbackMatching(params: MatchingParams): MatchingResult {
    // Simple priority-based matching
    const { buyOrders, sellOrders, minFillRatio } = params;
    
    const fills: Fill[] = [];
    const remainingBuys = [...buyOrders];
    const remainingSells = [...sellOrders];
    
    // Sort by price then timestamp
    buyOrders.sort((a, b) => parseFloat(b.price) - parseFloat(a.price));
    sellOrders.sort((a, b) => parseFloat(a.price) - parseFloat(b.price));
    
    for (const buyOrder of buyOrders) {
      if (remainingSells.length === 0) break;
      
      const bestSell = remainingSells.find(sell => 
        parseFloat(sell.price) <= parseFloat(buyOrder.price)
      );
      
      if (!bestSell) continue;
      
      // Calculate fill amount
      const fillAmount = Math.min(
        parseFloat(buyOrder.remainingAmount),
        parseFloat(bestSell.remainingAmount)
      );
      
      if (fillAmount * parseFloat(buyOrder.price) >= minFillRatio) {
        fills.push({
          orderId: buyOrder.orderId,
          counterOrderId: bestSell.orderId,
          filledAmount: fillAmount.toFixed(8),
          filledPrice: buyOrder.price,
          timestamp: Date.now(),
        });
        
        // Update remaining amounts
        remainingBuys.forEach(o => {
          if (o.orderId === buyOrder.orderId) {
            o.remainingAmount = (parseFloat(o.remainingAmount) - fillAmount).toFixed(8);
          }
        });
        
        remainingSells.forEach(o => {
          if (o.orderId === bestSell.orderId) {
            o.remainingAmount = (parseFloat(o.remainingAmount) - fillAmount).toFixed(8);
          }
        });
      }
    }
    
    return {
      fills,
      remainingBuys: remainingBuys.filter(o => parseFloat(o.remainingAmount) > 0),
      remainingSells: remainingSells.filter(o => parseFloat(o.remainingAmount) > 0),
    };
  }
}

// Type definitions
interface MatchingParams {
  buyOrders: LimitOrder[];
  sellOrders: LimitOrder[];
  minFillRatio: number;
  maxMatches?: number;
}

interface Fill {
  orderId: string;
  counterOrderId: string;
  filledAmount: string;
  filledPrice: string;
  timestamp: number;
}

interface MatchingResult {
  fills: Fill[];
  remainingBuys: LimitOrder[];
  remainingSells: LimitOrder[];
}
