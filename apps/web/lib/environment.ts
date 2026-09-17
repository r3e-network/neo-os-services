/**
 * Environment Isolation System for Neo-OS
 * 
 * P1 Security Requirement: Prevent cross-environment configuration contamination
 * 
 * This module provides:
 * - Strict environment detection and validation
 * - Production credential protection in non-production environments
 * - Config schema validation per environment
 * - Type-safe environment configuration
 * 
 * @example
 * import { validateEnvironment, getEnvironment } from '@/lib/environment'
 * 
 * // Early validation at startup
 * validateEnvironment('development')
 * 
 * // Safe configuration access
 * const env = getEnvironment()
 * console.log(env.name) // 'development' | 'staging' | 'production'
 */

export type EnvironmentName = 'development' | 'staging' | 'production'

export interface EnvironmentConfig {
  name: EnvironmentName
  isDevelopment: boolean
  isStaging: boolean
  isProduction: boolean
  nodeEnv: string
  vercelEnv: string | null
}

// ============================================================================
// Environment Detection
// ============================================================================

const detectEnvironmentFromNodeEnv = (): EnvironmentName => {
  const nodeEnv = process.env.NODE_ENV?.toLowerCase().trim()
  
  if (nodeEnv === 'production') return 'production'
  if (nodeEnv === 'staging') return 'staging'
  if (nodeEnv === 'test') return 'development'
  if (nodeEnv === 'development' || !nodeEnv) return 'development'
  
  // Unknown NODE_ENV - default to development for safety
  console.warn(`[Environment] Unknown NODE_ENV: "${nodeEnv}", defaulting to "development"`)
  return 'development'
}

const detectEnvironmentFromVercel = (): EnvironmentName | null => {
  // Vercel sets VERCEL_ENV explicitly for each deployment slot
  const vercelEnv = process.env.VERCEL_ENV?.toLowerCase().trim()
  
  if (!vercelEnv) return null
  
  if (vercelEnv === 'production') return 'production'
  if (vercelEnv === 'preview' || vercelEnv === 'staging') return 'staging'
  if (vercelEnv === 'development') return 'development'
  
  console.warn(`[Environment] Unknown VERCEL_ENV: "${vercelEnv}"`)
  return null
}

const detectEnvironment = (): EnvironmentName => {
  // Vercel's VERCEL_ENV takes precedence over NODE_ENV
  const vercelResult = detectEnvironmentFromVercel()
  if (vercelResult) return vercelResult
  
  return detectEnvironmentFromNodeEnv()
}

export const getEnvironment = (): EnvironmentConfig => {
  const name = detectEnvironment()
  
  return {
    name,
    isDevelopment: name === 'development',
    isStaging: name === 'staging',
    isProduction: name === 'production',
    nodeEnv: process.env.NODE_ENV ?? 'development',
    vercelEnv: process.env.VERCEL_ENV ?? null,
  }
}

// ============================================================================
// Validation & Safety Guards
// ============================================================================

interface ValidationResult {
  isValid: boolean
  errors: string[]
  warnings: string[]
}

export const validateEnvironment = (
  expectedEnv?: EnvironmentName,
  strictMode: boolean = false
): ValidationResult => {
  const env = getEnvironment()
  const result: ValidationResult = {
    isValid: true,
    errors: [],
    warnings: [],
  }

  // Check environment mismatch
  if (expectedEnv && env.name !== expectedEnv) {
    result.errors.push(
      `Environment mismatch: expected "${expectedEnv}" but running in "${env.name}"`
    )
    result.isValid = false
    
    if (strictMode) {
      throw new Error(
        `[Environment Validation] ${result.errors[0]}. Aborting startup.`
      )
    }
  }

  // Critical: Block production credentials in non-production environments
  const prodCredentialVars = [
    'NEO_RPC_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'SUPABASE_SERVICE_KEY',
    'MORPHEUS_RELAYER_NEO_N3_PRIVATE_KEY',
    'MORPHEUS_RELAYER_NEO_N3_WIF',
    'PHALA_NEO_N3_PRIVATE_KEY',
    'NEO_N3_WIF',
    'WEB3AUTH_CLIENT_SECRET',
    'CLOUDFLARE_API_TOKEN',
    'TURNSTILE_SECRET_KEY',
    'ADMIN_CONSOLE_API_KEY',
    'MINIAPP_ADMIN_API_KEY',
    'CRON_SECRET',
    'SECRETS_MASTER_KEY',
    'POOL_MASTER_KEY',
    'NEOFEEDS_SIGNING_KEY',
    'NEOVRF_SIGNING_KEY',
  ]

  const blockedCredentials: Record<string, boolean> = {}
  
  prodCredentialVars.forEach((key) => {
    const value = process.env[key]
    if (value && value.trim().length > 0) {
      blockedCredentials[key] = true
      
      // In development or staging, block known production values
      if (!env.isProduction) {
        const isProdValue = checkIfProductionValue(value, key)
        
        if (isProdValue) {
          result.errors.push(
            `SECURITY VIOLATION: Production credential "${key}" detected in "${env.name}" environment`
          )
          result.isValid = false
          
          if (strictMode) {
            throw new Error(
              `[Security Blocker] Production credentials cannot be used in ${env.name}. Aborting.`
            )
          }
        }
      }
    }
  })

  // Warning: Prod-only services missing in production
  if (env.isProduction) {
    const requiredProdServices = ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN']
    const missingServices = requiredProdServices.filter(
      (key) => !process.env[key] || process.env[key]?.trim() === ''
    )
    
    if (missingServices.length > 0) {
      result.warnings.push(
        `Production requires Upstash Redis for rate limiting. Missing: ${missingServices.join(', ')}`
      )
    }

    // Check for dangerous development settings in production
    const dangerousProdSettings = [
      { key: 'MORPHEUS_GUARDS_REQUIRED', allowedValue: 'true' },
      { key: 'NEO_ACCOUNTS_ALLOW_EPHEMERAL_MASTER_KEY', allowedValue: 'false' },
      { key: 'DEBUG', allowedValue: 'false' },
    ]

    dangerousProdSettings.forEach(({ key, allowedValue }) => {
      const value = process.env[key]?.toLowerCase()
      if (value && value !== allowedValue) {
        result.warnings.push(
          `Production security: ${key} should be "${allowedValue}" (found: "${value}")`
        )
      }
    })
  }

  // Warning: Non-production using production endpoints
  if (!env.isProduction) {
    const prodEndpoints = [
      { key: 'NEO_RPC_URL', pattern: /mainnet/i },
      { key: 'MORPHEUS_RUNTIME_URL', pattern: /meshmini\.app\/mainnet/i },
      { key: 'NEXT_PUBLIC_MORPHEUS_NETWORK', pattern: /mainnet/i },
    ]

    prodEndpoints.forEach(({ key, pattern }) => {
      const value = process.env[key]
      if (value && pattern.test(value)) {
        result.warnings.push(
          `${key} appears to point to production network while running in ${env.name}`
        )
      }
    })
  }

  return result
}

// Check if a credential value looks like a production value
const checkIfProductionValue = (value: string, _key: string): boolean => {
  // Pattern matching for common production credential formats
  
  // Private keys (hex format, 64 chars for ECDSA, 32 for symmetric)
  if (/^[0-9a-fA-F]{64}$/.test(value)) return true
  if (/^[0-9a-fA-F]{32}$/.test(value)) return true
  
  // WIF format (starts with 5, K, L, or prefix "L5..." for testnet)
  if (/^([5][1-9A-HJ-NP-Za-km-z]{50,51}|L[KPWRS]*[1-9A-H-J-NP-U-Z]{50,51})$/.test(value)) {
    // Testnet WIF starts with L, production uses 5 or K
    return value.startsWith('5') || value.startsWith('K')
  }
  
  // JWT tokens (Vercel OIDC pattern)
  if (/^eyJ[A-Za-z0-9_-]*\.eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*$/.test(value)) {
    try {
      const payload = JSON.parse(atob(value.split('.')[1]))
      // Vercel production tokens have specific subject patterns
      if (payload.sub?.includes(':environment:') && !payload.sub.includes('development')) {
        return true
      }
    } catch {
      // Not a valid JWT, continue checking
    }
  }
  
  // API keys (common prefixes)
  if (/^(?:vcp_|sk_live_)/.test(value) || /^[A-Za-z0-9]{40}$/.test(value)) return true
  
  // Supabase service keys (long alphanumeric strings)
  if (value.length > 40 && /^[A-Za-z0-9_-]+$/.test(value)) {
    return true
  }
  
  // Cloudflare tokens
  if (/^[a-zA-Z0-9_-]{37,40}$/.test(value)) return true
  
  return false
}

// ============================================================================
// Configuration Schema Validation
// ============================================================================

export const validateConfigSchema = (
  env: EnvironmentName,
  requiredKeys: string[],
  _optionalKeys: string[] = []
): ValidationResult => {
  const result: ValidationResult = {
    isValid: true,
    errors: [],
    warnings: [],
  }

  // Check required keys
  const missingRequired = requiredKeys.filter(
    (key) => !process.env[key] || process.env[key]?.trim() === ''
  )

  if (missingRequired.length > 0) {
    result.errors.push(
      `Missing required configuration for ${env}: ${missingRequired.join(', ')}`
    )
    result.isValid = false
  }

  // Check for dangerous exposed keys
  const dangerousPublicKeys = [
    'SUPABASE_SERVICE_ROLE_KEY',
    'SUPABASE_SERVICE_KEY',
    'MORPHEUS_RELAYER_NEO_N3_PRIVATE_KEY',
    'MORPHEUS_RELAYER_NEO_N3_WIF',
    'NEO_N3_WIF',
    'NEOFEEDS_SIGNING_KEY',
    'POOL_MASTER_KEY',
    'SECRETS_MASTER_KEY',
  ]

  dangerousPublicKeys.forEach((key) => {
    if (process.env[key]) {
      // Check if accidentally exposed as NEXT_PUBLIC_
      const publicKey = `NEXT_PUBLIC_${key}`
      if (process.env[publicKey]) {
        result.errors.push(
          `CRITICAL SECURITY: "${key}" must not be exposed as "${publicKey}". ` +
            `Server-side secrets cannot be bundled into browser client code.`
        )
        result.isValid = false
      }
    }
  })

  return result
}

// ============================================================================
// Environment-Specific Default Values
// ============================================================================

export const getDefaultsForEnvironment = (env: EnvironmentName): Record<string, string> => {
  const defaults: Record<string, string> = {}

  switch (env) {
    case 'development':
      Object.assign(defaults, {
        NEO_RPC_URL: 'https://api.n3index.dev/testnet',
        NEO_NETWORK_MAGIC: '894710606',
        MORPHEUS_RUNTIME_URL: 'http://localhost:8080',
        DEBUG: 'true',
        MORPHEUS_GUARDS_REQUIRED: 'false',
      })
      break

    case 'staging':
      Object.assign(defaults, {
        NEO_RPC_URL: 'https://api.n3index.dev/testnet',
        NEO_NETWORK_MAGIC: '894710606',
        MORPHEUS_RUNTIME_URL: 'https://oracle.meshmini.app/testnet',
        DEBUG: 'false',
        MORPHEUS_GUARDS_REQUIRED: 'true',
        UPSTASH_REDIS_REST_URL: '', // Must be configured manually
        UPSTASH_REDIS_REST_TOKEN: '', // Must be configured manually
      })
      break

    case 'production':
      Object.assign(defaults, {
        NEO_RPC_URL: 'https://api.n3index.dev/mainnet',
        NEO_NETWORK_MAGIC: '860833102',
        MORPHEUS_RUNTIME_URL: 'https://oracle.meshmini.app/mainnet',
        MORPHEUS_CONTROL_PLANE_URL: 'https://control.meshmini.app',
        DEBUG: 'false',
        MORPHEUS_GUARDS_REQUIRED: 'true',
        MORPHEUS_UPSTASH_FAIL_CLOSED: 'false',
        // Upstash URLs must be configured in production secrets manager
      })
      break
  }

  return defaults
}
