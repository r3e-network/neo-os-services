/**
 * Generate PDF and CSV exports for transaction history
 */

import fs from 'node:fs';
import PDFDocument from 'pdfkit';
import { TransactionRecord } from './types';

function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

export function generateCSVExport(transactions: TransactionRecord[]): Buffer {
  const headers = ['timestamp', 'tokenIn', 'tokenOut', 'amountIn', 'amountOut', 'feeAmount', 'hash'];
  const rows = transactions.map((t) => [
    new Date(t.timestamp).toISOString(),
    t.tokenIn,
    t.tokenOut,
    t.amountIn,
    t.amountOut,
    t.feeAmount,
    t.txHash ?? '',
  ].map((value) => csvCell(value)));

  return Buffer.from([headers.map(csvCell).join(','), ...rows.map((row) => row.join(','))].join('\n') + '\n');
}

export function generatePDFExport(transactions: TransactionRecord[], outputPath: string): void {
  const doc = new PDFDocument({ autoFirstPage: true });
  
  // Cover page
  doc.fontSize(24).text('NeoSwap v2 Trading Activity Report', { align: 'center' });
  doc.text(`Generated: ${new Date().toLocaleString()}`, { align: 'center' });
  doc.moveDown();
  
  // Transaction summary
  doc.fontSize(16).text('Transaction Summary', { align: 'left' });
  
  const stats = {
    totalTransactions: transactions.length,
    totalVolume: transactions.reduce((sum, t) => sum + parseFloat(t.amountIn), 0).toFixed(2),
    totalFees: transactions.reduce((sum, t) => sum + parseFloat(t.feeAmount), 0).toFixed(6),
  };
  
  doc.fontSize(12);
  doc.text(`Total Trades: ${stats.totalTransactions}`);
  doc.text(`Total Volume: ${stats.totalVolume} tokens`);
  doc.text(`Total Fees: ${stats.totalFees} tokens`);
  doc.moveDown();
  
  // Detailed transactions table
  doc.fontSize(14).text('Transaction Details', { align: 'left' });
  
  for (const tx of transactions.slice(0, 50)) {
    doc.addPage();
    doc.fontSize(12);
    doc.text(`Time: ${new Date(tx.timestamp).toLocaleString()}`);
    doc.text(`From: ${tx.tokenIn}`);
    doc.text(`To: ${tx.tokenOut}`);
    doc.text(`Amount In: ${tx.amountIn}`);
    doc.text(`Amount Out: ${tx.amountOut}`);
    doc.text(`Fee: ${tx.feeAmount}`);
    doc.text(`Tx Hash: ${tx.txHash || 'Pending'}`);
  }
  
  doc.pipe(fs.createWriteStream(outputPath));
  doc.end();
}
