/**
 * Generate PDF and CSV exports for transaction history
 */

import { Document, Page, Text, View, Image } from '@pdfkit/pdfkit';
import { parse } from 'csv-parse/sync';
import { Readable } from 'stream';
import { TransactionRecord } from '../types';

export function generateCSVExport(transactions: TransactionRecord[]): Buffer {
  const csvString = JSON.stringify(transactions, null, 2);
  
  // Parse JSON to CSV format
  const records = transactions.map(t => ({
    timestamp: new Date(t.timestamp).toISOString(),
    tokenIn: t.tokenIn,
    tokenOut: t.tokenOut,
    amountIn: t.amountIn,
    amountOut: t.amountOut,
    feeAmount: t.feeAmount,
    hash: t.txHash,
  }));

  const parser = parse(records, {
    columns: true,
    quoted: true,
  });

  return Buffer.from(parser.toString());
}

export function generatePDFExport(transactions: TransactionRecord[], outputPath: string): void {
  const doc = new Document();
  
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
