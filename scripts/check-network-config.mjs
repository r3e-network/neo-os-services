#!/usr/bin/env node
/**
 * @fileoverview Network Configuration Validator
 *
 * Validates that MORPHEUS_NETWORK is properly configured before deployment.
 * This is a focused check that runs independently of other environment checks.
 *
 * Usage:
 *   npm run check:network-config
 *   node scripts/check-network-config.mjs --fail-on-missing
 *   node scripts/check-network-config.mjs --expected mainnet
 */

// Parse command-line arguments. Both `--expected X` and `--expected=X` are
// accepted; malformed usage fails the run instead of silently disabling the
// expected-network check. `--fail-on-missing` is consumed for compatibility;
// missing configuration already fails on its own.
const args = process.argv.slice(2);

let argError = null;
let expectedNetwork = null;
{
  const VALID_NETWORKS = new Set(['mainnet', 'testnet']);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--fail-on-missing') continue;
    if (arg === '--expected' || arg.startsWith('--expected=')) {
      const value = arg === '--expected' ? args[i + 1] : arg.slice('--expected='.length);
      if (arg === '--expected') i++;
      const normalized = (value ?? '').trim().toLowerCase();
      if (!normalized || normalized.startsWith('--')) {
        argError = 'missing value for --expected (usage: --expected mainnet | --expected=mainnet)';
        break;
      }
      if (!VALID_NETWORKS.has(normalized)) {
        argError = `unsupported --expected value "${value}" (expected one of: mainnet, testnet)`;
        break;
      }
      if (expectedNetwork && expectedNetwork !== normalized) {
        argError = `conflicting --expected values "${expectedNetwork}" and "${normalized}"`;
        break;
      }
      expectedNetwork = normalized;
      continue;
    }
    argError = `unknown argument "${arg}" (supported: --fail-on-missing, --expected mainnet, --expected=mainnet)`;
    break;
  }
}

// Import trimString utility if available, otherwise define simple fallback
let trimString;
try {
  const utils = await import('./lib-utils.mjs');
  trimString = utils.trimString || ((s) => s?.trim() || '');
} catch {
  trimString = (s) => s?.trim() || '';
}

/**
 * Validate Morpheus network configuration
 *
 * @returns {{ ok: boolean, errors: string[], warnings: string[], envValue?: string }}
 */
function validateMorpheusNetworkConfig() {
  const result = {
    ok: true,
    errors: [],
    warnings: [],
  };

  // Check both environment variable names
  const rawRuntime = process.env.MORPHEUS_NETWORK;
  const rawPublic = process.env.NEXT_PUBLIC_MORPHEUS_NETWORK;

  const selectedEnv = trimString(rawRuntime) || trimString(rawPublic);

  // CRITICAL CHECK: Must have at least one network variable set
  if (!selectedEnv) {
    result.ok = false;
    result.errors.push(
      'CRITICAL: Neither MORPHEUS_NETWORK nor NEXT_PUBLIC_MORPHEUS_NETWORK is set.',
      '',
      'The application will refuse to start without explicit network configuration.',
      '',
      'To fix this, set one of these environment variables:',
      '  export MORPHEUS_NETWORK=testnet',
      '  OR add to .env file:',
      '  MORPHEUS_NETWORK=testnet',
      '',
      'Valid values: "testnet" or "mainnet"',
      'Example: export MORPHEUS_NETWORK=testnet'
    );
    return result;
  }

  // Normalize and validate the value
  const normalized = selectedEnv.toLowerCase();

  if (normalized !== 'testnet' && normalized !== 'mainnet') {
    result.ok = false;
    result.errors.push(
      `Invalid network value "${selectedEnv}"`,
      '',
      `Expected one of: "testnet" or "mainnet"`
    );

    // Common typos
    const typoMap = {
      mianet: 'mainnet',
      tests: 'testnet',
      production: 'mainnet',
      staging: 'testnet',
      dev: 'testnet',
    };

    for (const [typo, correct] of Object.entries(typoMap)) {
      if (normalized.includes(typo)) {
        result.warnings.push(
          `Possible typo detected: "${selectedEnv}" → did you mean "${correct}"?`
        );
      }
    }

    return result;
  }

  // If expected network was specified, verify match
  if (expectedNetwork) {
    const expectedNormalized = expectedNetwork.toLowerCase();
    if (normalized !== expectedNormalized) {
      result.ok = false;
      result.errors.push(
        `Network mismatch: expected "${expectedNetwork}" but got "${selectedEnv}"`
      );
    } else {
      result.warnings.push(`✓ Network correctly set to "${selectedEnv}" (as expected)`);
    }
  } else {
    result.warnings.push(`✓ Network detected: "${selectedEnv}"`);
  }

  // Check for mixed configuration scenarios
  if (rawRuntime && rawPublic && trimString(rawRuntime) !== trimString(rawPublic)) {
    result.warnings.push(
      '⚠ WARNING: MORPHEUS_NETWORK and NEXT_PUBLIC_MORPHEUS_NETWORK differ.',
      '  Runtime:  ',
      rawRuntime,
      '  Public:   ',
      rawPublic,
      '',
      'This may cause confusion between server-side and client-side network selection.'
    );
  }

  // Environment-specific recommendations
  if (normalized === 'mainnet') {
    const productionChecks = [
      ['UPSTASH_REDIS_REST_URL', 'Production rate limiting'],
      ['MORPHEUS_MAINNET_RUNTIME_URL', 'Mainnet runtime endpoint'],
      ['SIGNER_ROLE_UPDATER_KEY_ID', 'Custody signer configured'],
      ['MORPHEUS_RELAYER_MODE', 'Relayer mode configured'],
    ];

    console.log('📋 Mainnet deployment checklist:');
    for (const [envVar, description] of productionChecks) {
      if (process.env[envVar]) {
        console.log(`   ✓ ${envVar}: ${description}`);
      } else {
        result.warnings.push(`Consider setting ${envVar} for ${description}`);
      }
    }
  } else if (normalized === 'testnet') {
    const testnetChecks = [
      ['NEO_NETWORK_MAGIC', 'Testnet RPC magic number'],
      ['MORPHEUS_PAYMASTER_TESTNET_ENABLED', 'Paymaster configuration'],
      ['MORPHEUS_RELAYER_NEO_N3_SCAN_MODE', 'Block scan mode'],
    ];

    console.log('📋 Testnet deployment checklist:');
    for (const [envVar, description] of testnetChecks) {
      if (process.env[envVar]) {
        console.log(`   ✓ ${envVar}: ${description}`);
      } else {
        result.warnings.push(`Consider setting ${envVar} for ${description}`);
      }
    }
  }

  return result;
}

/**
 * Print validation report in human-readable format
 */
function printReport(result, exitCode) {
  console.log('\n========================================');
  console.log('Morpheus Network Configuration Validator');
  console.log('========================================\n');

  if (result.ok) {
    console.log('✅ VALIDATION PASSED\n');
  } else {
    console.log('❌ VALIDATION FAILED\n');
  }

  if (result.warnings.length > 0) {
    console.log('Warnings / Recommendations:');
    console.log('─'.repeat(56));
    for (const warning of result.warnings) {
      console.log(warning);
    }
    console.log('');
  }

  if (result.errors.length > 0) {
    console.log('Errors:');
    console.log('─'.repeat(56));
    for (const error of result.errors) {
      if (error) console.log(error);
    }
    console.log('');
  }

  if (result.envValue) {
    console.log(`Detected MORPHEUS_NETWORK: ${result.envValue}`);
  }

  console.log('========================================');

  if (exitCode) {
    process.exitCode = exitCode;
  }
}

// Main execution
console.log('🔍 Validating Morpheus network configuration...\n');

if (argError) {
  console.error(`Argument error: ${argError}`);
  process.exitCode = 1;
} else {
  const result = validateMorpheusNetworkConfig();
  // A valid configuration must pass even when --fail-on-missing is supplied:
  // that flag only requires a nonzero status when configuration is absent or
  // invalid, never an unconditional failure.
  const shouldFail = !result.ok;

  printReport(result, shouldFail ? 1 : 0);

  if (shouldFail) {
    console.log('\n💡 Next steps:');
    console.log('   1. Set MORPHEUS_NETWORK environment variable');
    console.log('   2. Re-run this validation script');
    console.log('   3. Review DEPLOYMENT_CHECKLIST.md for full requirements');
    process.exitCode = 1;
  } else {
    console.log('\n✅ Environment ready for deployment!');
  }
}
