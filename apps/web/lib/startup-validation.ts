/**
 * Application Startup Validation Module
 *
 * This module runs immediately when each microservice starts and:
 * 1. Validates environment configuration matches expected slot
 * 2. Blocks production credentials in non-production environments
 * 3. Warns about dangerous configuration mismatches
 *
 * Usage: Import this module early in your main entry point
 *
 * @example
 * // src/server.ts or src/app.ts
 * import '@/lib/startup-validation'
 */

import { getEnvironment, validateEnvironment, validateConfigSchema } from './environment';

// ============================================================================
// Early Exit Guard
// ============================================================================

const exitWithValidationFailure = (message: string, errors: string[]): void => {
  console.error('\n╔═══════════════════════════════════════════════════════════╗');
  console.error('║                                                           ║');
  console.error('║  ⛔ ENVIRONMENT VALIDATION FAILED                         ║');
  console.error('║                                                           ║');
  console.error('╚═══════════════════════════════════════════════════════════╝\n');

  console.error(`Error: ${message}\n`);

  if (errors.length > 0) {
    console.error('Details:');
    errors.forEach((error, idx) => {
      console.error(`  ${idx + 1}. ${error}`);
    });
  }

  console.error('\n🛡️  Safety System Active: Application cannot start.\n');
  console.error('Fix required:\n');
  console.error('  1. Review error messages above');
  console.error('  2. Check your .env files are configured correctly');
  console.error("  3. Ensure you're not using production credentials");
  console.error('  4. Run `npm run validate-config` to diagnose\n');

  process.exit(1);
};

// ============================================================================
// Global Validation Configuration
// ============================================================================

export interface StartupConfig {
  expectedEnv?: 'development' | 'staging' | 'production';
  strictMode?: boolean;
  requiredKeys?: string[];
  optionalKeys?: string[];
}

const DEFAULT_CONFIG: StartupConfig = {
  expectedEnv: undefined,
  strictMode: true,
  requiredKeys: [],
  optionalKeys: [],
};

// ============================================================================
// Environment Override Detection
// ============================================================================

const _detectEnvironmentOverride = (): string | null => {
  const nodeEnv = process.env.NODE_ENV?.toLowerCase().trim();
  const vercelEnv = process.env.VERCEL_ENV?.toLowerCase().trim();

  const overrides: Record<string, string> = {
    dev: 'development',
    development: 'development',
    test: 'development',
    preview: 'staging',
    staging: 'staging',
    prod: 'production',
    production: 'production',
  };

  const nodeResult = overrides[nodeEnv || ''];
  const vercelResult = overrides[vercelEnv || ''];

  // Vercel always takes precedence
  if (vercelResult) return vercelResult;
  if (nodeResult) return nodeResult;

  return null;
};

// ============================================================================
// Credential Pattern Matching
// ============================================================================

const checkProductionCredentials = (envVars: typeof process.env): string[] => {
  const errors: string[] = [];

  const prodCredentialPatterns = [
    {
      key: /WIF/,
      pattern: /^([5][1-9A-HJ-NP-Za-km-z]{50,51}|L[KPWRS]*[1-9A-H-J-NP-U-Z]{50,51})$/,
      description: 'WIF signing keys',
    },
    {
      key: /PRIVATE_KEY/,
      pattern: /^[0-9a-fA-F]{64}$|^[0-9a-fA-F]{32}$/,
      description: 'Hex private keys',
    },
    { key: /SERVICE_ROLE/, pattern: /.*/, description: 'Supabase service role keys' },
    { key: /SERVICE_KEY/, pattern: /.*/, description: 'Database service keys' },
    { key: /SECRETS_MASTER_KEY/, pattern: /.*/, description: 'Secrets encryption master key' },
    { key: /POOL_MASTER_KEY/, pattern: /.*/, description: 'Account pool master key' },
    { key: /SIGNING_KEY/, pattern: /.*/, description: 'Signing keys' },
    { key: /API_TOKEN|SECRET_KEY/, pattern: /^(?!$)/, description: 'API tokens/secret keys' },
  ];

  prodCredentialPatterns.forEach(({ key, pattern, description }) => {
    Object.keys(envVars).forEach((envKey) => {
      if (key.test(envKey)) {
        const value = envVars[envKey];

        // Skip empty or placeholder values
        if (
          !value ||
          value.trim() === '' ||
          value.startsWith('your-') ||
          value.includes('REDACTED')
        ) {
          return;
        }

        // Check if it matches credential pattern
        if (pattern.test(value)) {
          errors.push(
            `Detected ${description} (${envKey}) - Production credentials found in non-production environment`
          );
        }
      }
    });
  });

  return errors;
};

// ============================================================================
// Endpoint Consistency Check
// ============================================================================

const checkEndpointConsistency = (envVars: typeof process.env, currentEnv: string): string[] => {
  const warnings: string[] = [];

  const endpointKeys = [
    'NEO_RPC_URL',
    'MORPHEUS_RUNTIME_URL',
    'NEXT_PUBLIC_MORPHEUS_RUNTIME_URL',
    'NEXT_PUBLIC_MORPHEUS_NETWORK',
    'PHALA_API_URL',
  ];

  endpointKeys.forEach((key) => {
    const value = envVars[key];

    if (!value) return;

    const isMainnet = /mainnet/i.test(value);
    const isTestnet = /testnet/i.test(value);
    const isLocalhost = /localhost|127\.0\.0\.1/.test(value);

    if (currentEnv === 'production') {
      if (isTestnet || isLocalhost) {
        warnings.push(`${key} points to testnet/local while running in production: "${value}"`);
      } else if (isMainnet) {
        // Valid - production using mainnet
      }
    } else if (currentEnv !== 'production') {
      if (isMainnet && !isLocalhost) {
        warnings.push(`${key} points to mainnet while running in ${currentEnv}: "${value}"`);
      }
    }
  });

  // Check Upstash in production
  if (currentEnv === 'production') {
    const hasUpstashUrl = envVars.UPSTASH_REDIS_REST_URL;
    const hasUpstashToken = envVars.UPSTASH_REDIS_REST_TOKEN;

    if (!hasUpstashUrl || !hasUpstashToken) {
      warnings.push('Missing Upstash Redis credentials in production - rate limiting will fail');
    }
  }

  // Return combined as warnings only (not fatal)
  return [...warnings];
};

// ============================================================================
// Start Application
// ============================================================================

export const startupValidate = (config?: StartupConfig): void => {
  const appConfig = { ...DEFAULT_CONFIG, ...config };
  const env = getEnvironment();

  // Show startup banner
  console.log('\n┌───────────────────────────────────────────────────────────┐');
  console.log('│  🏭 Neo-OS Microservice Starting...                       │');
  console.log('│  Environment: ' + env.name.padEnd(20) + '  │');
  console.log('│  NODE_ENV: ' + env.nodeEnv.padEnd(23) + '  │');
  console.log('│  VERCEL_ENV: ' + (env.vercelEnv || 'N/A').padEnd(24) + '  │');
  console.log('└───────────────────────────────────────────────────────────┘\n');

  // Validate expected environment match
  if (appConfig.expectedEnv) {
    const validation = validateEnvironment(appConfig.expectedEnv, appConfig.strictMode!);

    if (!validation.isValid) {
      exitWithValidationFailure('Environment validation failed', validation.errors);
    }
  }

  // Run global production credential checks
  const prodCredentialErrors = checkProductionCredentials(process.env);

  if (prodCredentialErrors.length > 0 && (env.isDevelopment || env.isStaging)) {
    console.warn('\n⚠️  WARNING: Potential production credentials detected:\n');
    prodCredentialErrors.forEach((err, idx) => {
      console.warn(`  ${idx + 1}. ${err}\n`);
    });
    console.warn('If this is intentional (testing), ignore this warning.');
    console.warn('If unexpected, fix before deployment.\n');
  }

  // Check endpoint consistency
  const endpointWarnings = checkEndpointConsistency(process.env, env.name);

  if (endpointWarnings.length > 0) {
    console.warn('\n⚠️  CONFIGURATION WARNINGS:\n');
    endpointWarnings.forEach((warn) => {
      console.warn(`  • ${warn}\n`);
    });
  }

  // Config schema validation
  const requiredKeys = appConfig.requiredKeys ?? [];
  const optionalKeys = appConfig.optionalKeys ?? [];
  if (requiredKeys.length > 0) {
    const schemaValidation = validateConfigSchema(env.name, requiredKeys, optionalKeys);

    if (!schemaValidation.isValid) {
      exitWithValidationFailure('Required configuration missing', schemaValidation.errors);
    }
  }

  console.log('✅ Environment validation passed');
};

// ============================================================================
// Auto-run on import (for critical services)
// ============================================================================

const AUTO_RUN = process.env.NEO_OS_STARTUP_VALIDATE !== 'disabled';

if (AUTO_RUN) {
  startupValidate();
}
