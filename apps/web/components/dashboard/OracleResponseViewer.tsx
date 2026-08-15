'use client';

import type { OracleState } from '@/lib/dashboard-types';
import { CheckCircle2, Copy, Send } from 'lucide-react';

interface GeneratedRequest {
  requestType: string;
  payload: Record<string, unknown>;
  payloadJson: string;
  neoN3Snippet: string;
}

interface OracleResponseViewerProps {
  generatedRequest: GeneratedRequest;
  oracleState: OracleState | null;
  walletCallbackHash: string;
  walletCallbackMethod: string;
  oracleContract: string;
  payloadBase64: string;
  neoRpcInvoke: string;
  callbackQueryTemplate: string;
  copiedItem: string | null;
  onCopy: (id: string, value: string) => void;
  isWalletSubmitting?: boolean;
  onSubmitWithWallet?: () => void;
  canSubmitWithWallet?: boolean;
  readinessLabel?: string;
  readinessDetail?: string;
  readinessTone?: 'success' | 'warning';
}

export function OracleResponseViewer({
  generatedRequest,
  oracleState,
  walletCallbackHash,
  walletCallbackMethod,
  oracleContract,
  payloadBase64,
  neoRpcInvoke,
  callbackQueryTemplate,
  copiedItem,
  onCopy,
  isWalletSubmitting = false,
  onSubmitWithWallet,
  canSubmitWithWallet = false,
  readinessLabel = 'Package generated',
  readinessDetail = '',
  readinessTone = 'success',
}: OracleResponseViewerProps) {
  const readinessColor = readinessTone === 'success' ? 'var(--neo-green)' : 'var(--warning)';

  return (
    <div className="card-industrial stagger-3" style={{ padding: '0' }}>
      <div
        style={{
          padding: '1.5rem',
          borderBottom: '1px solid var(--border-dim)',
          background: 'rgba(83, 58, 253, 0.045)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: '1rem',
          flexWrap: 'wrap',
        }}
      >
        <div>
          <h3
            style={{
              fontSize: '0.9rem',
              fontWeight: 800,
              textTransform: 'uppercase',
              fontFamily: 'var(--font-mono)',
              marginBottom: '0.25rem',
            }}
          >
            Generated Oracle Package
          </h3>
          <div
            style={{
              fontSize: '0.75rem',
              color: 'var(--text-secondary)',
              fontFamily: 'var(--font-mono)',
            }}
          >
            requestType = {generatedRequest.requestType}
          </div>
        </div>
        <div
          className="badge-outline"
          title={readinessDetail || undefined}
          style={{
            color: readinessColor,
            borderColor: readinessColor,
          }}
        >
          <CheckCircle2 size={12} style={{ marginRight: '6px' }} />
          {readinessLabel}
        </div>
      </div>

      <div style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
          <button
            className="btn-secondary"
            style={{ border: '1px solid var(--border-dim)' }}
            aria-label="Copy oracle payload JSON"
            onClick={() => onCopy('payload', generatedRequest.payloadJson)}
          >
            <Copy size={14} /> {copiedItem === 'payload' ? 'Copied Payload' : 'Copy Payload JSON'}
          </button>
          <button
            className="btn-secondary"
            style={{ border: '1px solid var(--border-dim)' }}
            aria-label="Copy Neo N3 contract snippet"
            onClick={() => onCopy('n3', generatedRequest.neoN3Snippet)}
          >
            <Copy size={14} /> {copiedItem === 'n3' ? 'Copied N3' : 'Copy Neo N3 Snippet'}
          </button>
          {onSubmitWithWallet && (
            <button
              className="btn btn-primary"
              onClick={onSubmitWithWallet}
              disabled={isWalletSubmitting || !canSubmitWithWallet}
              title={!canSubmitWithWallet && readinessDetail ? readinessDetail : undefined}
              aria-label="Submit oracle request with NEP-21 wallet"
            >
              <Send size={14} /> {isWalletSubmitting ? 'Submitting...' : 'Submit with NEP-21'}
            </button>
          )}
        </div>

        {readinessDetail && (
          <div
            aria-live="polite"
            style={{
              padding: '0.95rem 1rem',
              background:
                readinessTone === 'success' ? 'rgba(35, 134, 54, 0.08)' : 'rgba(245, 158, 11, 0.1)',
              border: `1px solid ${readinessColor}`,
              borderRadius: 'var(--ns-radius-md)',
              color: 'var(--text-secondary)',
              lineHeight: 1.7,
              overflowWrap: 'anywhere',
              wordBreak: 'break-word',
            }}
          >
            {readinessDetail}
          </div>
        )}

        <div className="grid grid-2" style={{ gap: '1rem' }}>
          <div
            style={{
              padding: '1rem',
              background: 'var(--bg-panel)',
              border: '1px solid var(--border-dim)',
              borderRadius: 'var(--ns-radius-md)',
            }}
          >
            <div
              style={{
                fontSize: '0.65rem',
                color: 'var(--text-secondary)',
                fontWeight: 800,
                marginBottom: '0.35rem',
                fontFamily: 'var(--font-mono)',
              }}
            >
              ORACLE CONTRACT
            </div>
            <div
              style={{
                fontSize: '0.8rem',
                color: 'var(--text-primary)',
                fontFamily: 'var(--font-mono)',
                wordBreak: 'break-word',
              }}
            >
              {oracleState?.contract || oracleContract}
            </div>
          </div>
          <div
            style={{
              padding: '1rem',
              background: 'var(--bg-panel)',
              border: '1px solid var(--border-dim)',
              borderRadius: 'var(--ns-radius-md)',
            }}
          >
            <div
              style={{
                fontSize: '0.65rem',
                color: 'var(--text-secondary)',
                fontWeight: 800,
                marginBottom: '0.35rem',
                fontFamily: 'var(--font-mono)',
              }}
            >
              REQUEST FEE
            </div>
            <div
              style={{
                fontSize: '0.8rem',
                color: 'var(--text-primary)',
                fontFamily: 'var(--font-mono)',
              }}
            >
              {oracleState?.request_fee_display || '0.01 GAS'}
            </div>
          </div>
        </div>

        <div
          style={{
            background: 'var(--bg-panel)',
            border: '1px solid var(--border-dim)',
            padding: '1rem',
            borderRadius: 'var(--ns-radius-md)',
          }}
        >
          <div
            style={{
              fontSize: '0.65rem',
              color: 'var(--text-secondary)',
              fontWeight: 800,
              marginBottom: '0.5rem',
              fontFamily: 'var(--font-mono)',
            }}
          >
            PAYLOAD JSON
          </div>
          <pre
            style={{
              margin: 0,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              color: 'var(--neo-green)',
              fontFamily: 'var(--font-mono)',
              fontSize: '0.78rem',
            }}
          >
            {JSON.stringify(generatedRequest.payload, null, 2)}
          </pre>
        </div>

        <div className="grid grid-2" style={{ gap: '1rem' }}>
          <div
            style={{
              background: 'var(--bg-panel)',
              border: '1px solid var(--border-dim)',
              padding: '1rem',
              borderRadius: 'var(--ns-radius-md)',
            }}
          >
            <div
              style={{
                fontSize: '0.65rem',
                color: 'var(--text-secondary)',
                fontWeight: 800,
                marginBottom: '0.5rem',
                fontFamily: 'var(--font-mono)',
              }}
            >
              PAYLOAD BYTEARRAY (BASE64 UTF-8)
            </div>
            <pre
              style={{
                margin: 0,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
                color: 'var(--neo-green)',
                fontFamily: 'var(--font-mono)',
                fontSize: '0.78rem',
              }}
            >
              {payloadBase64}
            </pre>
          </div>
          <div
            style={{
              background: 'var(--bg-panel)',
              border: '1px solid var(--border-dim)',
              padding: '1rem',
              borderRadius: 'var(--ns-radius-md)',
            }}
          >
            <div
              style={{
                fontSize: '0.65rem',
                color: 'var(--text-secondary)',
                fontWeight: 800,
                marginBottom: '0.5rem',
                fontFamily: 'var(--font-mono)',
              }}
            >
              NEO N3 RPC invokeFunction
            </div>
            <pre
              style={{
                margin: 0,
                whiteSpace: 'pre-wrap',
                color: 'var(--text-primary)',
                fontFamily: 'var(--font-mono)',
                fontSize: '0.78rem',
              }}
            >
              {neoRpcInvoke}
            </pre>
          </div>
        </div>

        <div
          style={{
            background: 'var(--bg-panel)',
            border: '1px solid var(--border-dim)',
            padding: '1rem',
            borderRadius: 'var(--ns-radius-md)',
          }}
        >
          <div
            style={{
              fontSize: '0.65rem',
              color: 'var(--text-secondary)',
              fontWeight: 800,
              marginBottom: '0.5rem',
              fontFamily: 'var(--font-mono)',
            }}
          >
            NEO N3 SUBMISSION
          </div>
          <pre
            style={{
              margin: 0,
              whiteSpace: 'pre-wrap',
              color: 'var(--text-primary)',
              fontFamily: 'var(--font-mono)',
              fontSize: '0.78rem',
            }}
          >
            {generatedRequest.neoN3Snippet}
          </pre>
        </div>

        <div className="grid grid-2" style={{ gap: '1rem' }}>
          <div
            style={{
              background: 'var(--bg-panel)',
              border: '1px solid var(--border-dim)',
              padding: '1rem',
              borderRadius: 'var(--ns-radius-md)',
            }}
          >
            <div
              style={{
                fontSize: '0.65rem',
                color: 'var(--text-secondary)',
                fontWeight: 800,
                marginBottom: '0.5rem',
                fontFamily: 'var(--font-mono)',
              }}
            >
              NEO N3 CALL ARGUMENTS
            </div>
            <div style={{ color: 'var(--text-secondary)', lineHeight: 1.8 }}>
              <div>
                <strong style={{ color: 'var(--text-primary)' }}>Arg 1:</strong>{' '}
                <code>{generatedRequest.requestType}</code>
              </div>
              <div>
                <strong style={{ color: 'var(--text-primary)' }}>Arg 2:</strong> UTF-8 payload JSON
                bytes
              </div>
              <div>
                <strong style={{ color: 'var(--text-primary)' }}>Arg 3:</strong> callback contract ={' '}
                <code>Runtime.ExecutingScriptHash</code> for your own consumer, or{' '}
                <code>{walletCallbackHash}</code> for direct wallet testing
              </div>
              <div>
                <strong style={{ color: 'var(--text-primary)' }}>Arg 4:</strong> callback method ={' '}
                <code>{walletCallbackMethod}</code>
              </div>
              <div>
                <strong style={{ color: 'var(--text-primary)' }}>Fee:</strong>{' '}
                <code>{oracleState?.request_fee_display || '0.01 GAS'}</code>
              </div>
            </div>
          </div>
          <div
            style={{
              background: 'var(--bg-panel)',
              border: '1px solid var(--border-dim)',
              padding: '1rem',
              borderRadius: 'var(--ns-radius-md)',
            }}
          >
            <div
              style={{
                fontSize: '0.65rem',
                color: 'var(--text-secondary)',
                fontWeight: 800,
                marginBottom: '0.5rem',
                fontFamily: 'var(--font-mono)',
              }}
            >
              CALLBACK READBACK
            </div>
            <div style={{ color: 'var(--text-secondary)', lineHeight: 1.7 }}>
              <div>
                1. Submit to <code>{oracleState?.contract || oracleContract}</code>.
              </div>
              <div>
                2. Read the emitted <code>requestId</code>.
              </div>
              <div>
                3. Query your consumer contract&apos;s <code>getCallback(requestId)</code> or use
                the template below.
              </div>
              <div>
                4. Verify <code>output_hash</code>, <code>attestation_hash</code>, and{' '}
                <code>tee_attestation.report_data</code> in the verifier.
              </div>
            </div>
          </div>
        </div>

        <div
          style={{
            background: 'var(--bg-panel)',
            border: '1px solid var(--border-dim)',
            padding: '1rem',
            borderRadius: 'var(--ns-radius-md)',
          }}
        >
          <div
            style={{
              fontSize: '0.65rem',
              color: 'var(--text-secondary)',
              fontWeight: 800,
              marginBottom: '0.5rem',
              fontFamily: 'var(--font-mono)',
            }}
          >
            CALLBACK QUERY TEMPLATE
          </div>
          <pre
            style={{
              margin: 0,
              whiteSpace: 'pre-wrap',
              color: 'var(--text-primary)',
              fontFamily: 'var(--font-mono)',
              fontSize: '0.78rem',
            }}
          >
            {callbackQueryTemplate}
          </pre>
        </div>
      </div>
    </div>
  );
}
