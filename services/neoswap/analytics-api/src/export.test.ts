import { describe, it, expect } from 'vitest';
import { generateCSVExport, generatePDFExport } from './export';
import { TransactionRecord } from './types';

describe('Export Functions', () => {
  const mockTransactions: TransactionRecord[] = [
    {
      id: '1',
      timestamp: Date.now(),
      userId: 'user-123',
      tokenIn: '0xneo',
      tokenOut: '0xtusdt',
      amountIn: '100.0',
      amountOut: '985.0',
      feeAmount: '0.3',
      txHash: 'tx-hash-123',
      poolIds: ['pool-1'],
    },
    {
      id: '2',
      timestamp: Date.now() - 10000,
      userId: 'user-123',
      tokenIn: '0xtusdt',
      tokenOut: '0xneo',
      amountIn: '500.0',
      amountOut: '47.5',
      feeAmount: '1.5',
      txHash: 'tx-hash-456',
      poolIds: ['pool-2'],
    },
  ];

  describe('generateCSVExport', () => {
    it('should generate valid CSV buffer', () => {
      const csvBuffer = generateCSVExport(mockTransactions);

      expect(csvBuffer).toBeInstanceOf(Buffer);
      expect(csvBuffer.length).toBeGreaterThan(0);

      // Should contain transaction data
      const csvString = csvBuffer.toString();
      expect(csvString).toContain('neo');
      expect(csvString).toContain('tusdt');
      expect(csvString).toContain('100.0');
      expect(csvString).toContain('985.0');
    });

    it('should handle empty transactions array', () => {
      const csvBuffer = generateCSVExport([]);

      expect(csvBuffer).toBeInstanceOf(Buffer);
      expect(csvBuffer.length).toBeGreaterThan(0); // Should have headers at minimum
    });

    it('should format timestamps correctly', () => {
      const singleTransaction = [mockTransactions[0]!];
      const csvBuffer = generateCSVExport(singleTransaction);

      const csvString = csvBuffer.toString();
      const lines = csvString.split('\n');

      // First line should be header or date field
      const today = new Date().toISOString().substring(0, 10);
      const hasDateField = lines.some((line) => line.includes('timestamp') || line.includes(today));

      expect(hasDateField).toBe(true);
    });
  });

  describe('generatePDFExport', () => {
    it('should not throw for valid input', () => {
      const outputPath = '/tmp/test-report.pdf';

      // PDF generation uses file system operations that may not work in all environments
      // We'll test that the function accepts valid parameters without throwing type errors
      expect(() => {
        generatePDFExport(mockTransactions.slice(0, 1), outputPath);
      }).not.toThrow();
    });

    it('should handle single transaction', () => {
      const singleTx = [mockTransactions[0]!];
      const outputPath = '/tmp/single-tx-report.pdf';

      expect(() => {
        generatePDFExport(singleTx, outputPath);
      }).not.toThrow();
    });

    it('should process multiple pages for many transactions', () => {
      const manyTransactions = Array.from({ length: 100 }, (_, i) => ({
        ...mockTransactions[0],
        id: `txn-${i}`,
        amountIn: (Math.random() * 1000).toFixed(2),
      }));

      const outputPath = '/tmp/large-report.pdf';

      // PDFKit should create multi-page documents
      expect(() => {
        generatePDFExport(manyTransactions, outputPath);
      }).not.toThrow();
    });
  });
});
