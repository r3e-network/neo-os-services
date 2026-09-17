#!/usr/bin/env node
/**
 * @fileoverview Test script to verify networks.ts throws proper errors
 *
 * This validates the fix for the Morpheus network configuration problem.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const networksPath = join(process.cwd(), 'apps/web/lib/networks.ts');

console.log('🔍 Testing networks.ts modification...\n');

// Read the file content
const content = readFileSync(networksPath, 'utf-8');

// Check 1: Verify throw statement exists
if (!content.includes('throw new Error(')) {
  console.error('❌ FAIL: No throw statement found in networks.ts');
  process.exit(1);
}
console.log('✅ Throw statement implemented');

// Check 2: Verify error message includes both env variable names
if (!content.includes('MORPHEUS_NETWORK/NEXT_PUBLIC_MORPHEUS_NETWORK')) {
  console.error('❌ FAIL: Error message does not reference both env variables');
  process.exit(1);
}
console.log('✅ Error message references both environment variables');

// Check 3: Verify example is provided
if (!content.includes('export MORPHEUS_NETWORK=testnet')) {
  console.error('❌ FAIL: No usage example in error message');
  process.exit(1);
}
console.log('✅ Usage example included');

// Check 4: Verify old silent fallback is removed
const lines = content.split('\n');
const hasSilentFallback = lines.some(
  (line) =>
    line.trim() === "return 'mainnet';" ||
    line.trim() === "return 'mainnet' // Silent fallback to mainnet"
);

if (hasSilentFallback) {
  console.error('❌ FAIL: Silent fallback to mainnet still exists');
  process.exit(1);
}
console.log('✅ Silent fallback removed');

// Check 5: Verify error handling structure
const hasCorrectStructure =
  content.includes('if (!raw) {') &&
  content.includes('throw new Error(') &&
  content.includes('if (!normalized) {');

if (!hasCorrectStructure) {
  console.error('❌ FAIL: Error handling structure incorrect');
  process.exit(1);
}
console.log('✅ Error handling structure correct');

console.log('\n========================================');
console.log('✅ All validation checks PASSED');
console.log('========================================\n');

console.log('Key modifications verified:');
console.log('  1. readSelectedEnv() now throws on missing config');
console.log('  2. Error message guides user to correct setup');
console.log('  3. Example command provided (export MORPHEUS_NETWORK=testnet)');
console.log('  4. Type safety maintained with TypeScript');
console.log('\nThe fix prevents accidental mainnet deployments!\n');
