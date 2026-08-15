'use client';

import { useState, useRef, useEffect } from 'react';
import { ChevronDown, Check } from 'lucide-react';
import { getBrowserNetworkKey, getSelectedNetworkKey } from '@/lib/networks';

const networks = [
  { key: 'mainnet' as const, label: 'Mainnet', color: 'var(--neo-green)' },
  { key: 'testnet' as const, label: 'Testnet', color: 'var(--warning)' },
];

export function NetworkSelector() {
  const [isOpen, setIsOpen] = useState(false);
  const [selectedKey, setSelectedKey] = useState(getSelectedNetworkKey);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setSelectedKey(getBrowserNetworkKey());
  }, []);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleNetworkSelect = (key: 'mainnet' | 'testnet') => {
    setSelectedKey(key);
    setIsOpen(false);
    const url = new URL(window.location.href);
    url.searchParams.set('network', key);
    window.location.href = url.toString();
  };

  const selectedNetwork = networks.find((n) => n.key === selectedKey);
  const isMainnet = selectedKey === 'mainnet';

  return (
    <div ref={dropdownRef} style={{ position: 'relative' }}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '8px',
          padding: '0.5rem 0.75rem',
          background: isMainnet ? 'var(--neo-green-dim)' : 'rgba(245, 158, 11, 0.1)',
          border: `1px solid ${isMainnet ? 'rgba(22, 199, 132, 0.28)' : 'rgba(245, 158, 11, 0.3)'}`,
          borderRadius: '12px',
          color: isMainnet ? 'var(--neo-green)' : 'var(--warning)',
          fontSize: '0.75rem',
          fontWeight: 700,
          fontFamily: 'var(--font-mono)',
          cursor: 'pointer',
          transition: 'all 0.2s',
        }}
      >
        <span
          style={{
            width: '6px',
            height: '6px',
            borderRadius: '50%',
            background: isMainnet ? 'var(--neo-green)' : 'var(--warning)',
          }}
        />
        {selectedNetwork?.label || selectedKey.toUpperCase()}
        <ChevronDown size={14} />
      </button>

      {isOpen && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            right: 0,
            marginTop: '8px',
            background: 'var(--bg-card)',
            border: '1px solid var(--border-dim)',
            borderRadius: '12px',
            minWidth: '180px',
            zIndex: 1000,
            overflow: 'hidden',
            boxShadow: 'var(--ns-shadow-lg)',
          }}
        >
          <div
            style={{
              padding: '0.5rem 0',
              borderBottom: '1px solid var(--border-dim)',
            }}
          >
            <div
              style={{
                padding: '0.5rem 1rem',
                fontSize: '0.65rem',
                fontWeight: 700,
                color: 'var(--text-muted)',
                fontFamily: 'var(--font-mono)',
                textTransform: 'uppercase',
                letterSpacing: 0,
              }}
            >
              Select Network
            </div>
          </div>
          {networks.map((network) => (
            <button
              key={network.key}
              onClick={() => handleNetworkSelect(network.key)}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                width: '100%',
                padding: '0.75rem 1rem',
                background: selectedKey === network.key ? 'rgba(83, 58, 253, 0.07)' : 'transparent',
                border: 'none',
                color:
                  selectedKey === network.key ? 'var(--text-primary)' : 'var(--text-secondary)',
                fontSize: '0.85rem',
                cursor: 'pointer',
                textAlign: 'left',
                transition: 'background 0.2s',
              }}
              onMouseEnter={(e) => {
                if (selectedKey !== network.key) {
                  e.currentTarget.style.background = 'rgba(83, 58, 253, 0.06)';
                }
              }}
              onMouseLeave={(e) => {
                if (selectedKey !== network.key) {
                  e.currentTarget.style.background = 'transparent';
                }
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <span
                  style={{
                    width: '8px',
                    height: '8px',
                    borderRadius: '50%',
                    background: network.color,
                  }}
                />
                <div>
                  <div style={{ fontWeight: 600 }}>{network.label}</div>
                  <div
                    style={{
                      fontSize: '0.7rem',
                      color: 'var(--text-muted)',
                      fontFamily: 'var(--font-mono)',
                    }}
                  >
                    {network.key.toUpperCase()}
                  </div>
                </div>
              </div>
              {selectedKey === network.key && <Check size={16} color="var(--neo-green)" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
