'use client';

import { createContext, useCallback, useContext, useRef, useState } from 'react';
import { CheckCircle2, XCircle, AlertTriangle, Info, X } from 'lucide-react';

type ToastType = 'success' | 'error' | 'warning' | 'info';

type Toast = {
  id: string;
  type: ToastType;
  message: string;
  duration?: number;
};

type ToastContextType = {
  toasts: Toast[];
  addToast: (type: ToastType, message: string, duration?: number) => void;
  removeToast: (id: string) => void;
};

const ToastContext = createContext<ToastContextType | null>(null);

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used within ToastProvider');
  }
  return context;
}

const icons: Record<ToastType, typeof CheckCircle2> = {
  success: CheckCircle2,
  error: XCircle,
  warning: AlertTriangle,
  info: Info,
};

const colors: Record<ToastType, { bg: string; border: string; icon: string }> = {
  success: { bg: 'var(--neo-green-dim)', border: 'var(--neo-green)', icon: 'var(--neo-green)' },
  error: { bg: 'rgba(239, 68, 68, 0.1)', border: 'var(--error)', icon: 'var(--error)' },
  warning: { bg: 'rgba(245, 158, 11, 0.1)', border: 'var(--warning)', icon: 'var(--warning)' },
  info: { bg: 'rgba(59, 130, 246, 0.1)', border: 'var(--accent-blue)', icon: 'var(--accent-blue)' },
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastIdRef = useRef(0);

  const addToast = useCallback((type: ToastType, message: string, duration = 5000) => {
    const id = `toast-${++toastIdRef.current}`;
    setToasts((prev) => [...prev, { id, type, message, duration }]);

    if (duration > 0) {
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, duration);
    }
  }, []);

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ toasts, addToast, removeToast }}>
      {children}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        style={{
          position: 'fixed',
          bottom: 'clamp(16px, 4vw, 24px)',
          right: 'clamp(16px, 4vw, 24px)',
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
          zIndex: 9999,
          width: 'min(420px, calc(100vw - 32px))',
          maxWidth: 'calc(100vw - 32px)',
          pointerEvents: 'none',
        }}
      >
        {toasts.map((toast) => {
          const Icon = icons[toast.type];
          const color = colors[toast.type];
          return (
            <div
              key={toast.id}
              style={{
                background: color.bg,
                border: `1px solid ${color.border}`,
                borderRadius: '16px',
                padding: '16px',
                display: 'flex',
                alignItems: 'flex-start',
                gap: '12px',
                backdropFilter: 'blur(12px)',
                animation: 'slideInRight 0.3s ease-out',
                pointerEvents: 'auto',
              }}
            >
              <Icon size={20} color={color.icon} style={{ flexShrink: 0, marginTop: '2px' }} />
              <div
                style={{
                  flex: 1,
                  color: 'var(--text-primary)',
                  fontSize: '0.9rem',
                  lineHeight: 1.5,
                  minWidth: 0,
                  overflowWrap: 'anywhere',
                }}
              >
                {toast.message}
              </div>
              <button
                onClick={() => removeToast(toast.id)}
                aria-label="Dismiss notification"
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'var(--text-secondary)',
                  cursor: 'pointer',
                  padding: '4px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}
              >
                <X size={16} />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}
