/**
 * <WalletStatusBanner /> — a drop-in top-of-dashboard alert.
 *
 * Renders nothing if the wallet is in a normal state. Renders an
 * amber or red banner for CREATED / LOCKED / RECOVERING /
 * OWNERSHIP_TRANSFER / SUSPENDED / missing-nominees.
 *
 * Usage (in your existing dashboard layout):
 *
 *   import { WalletStatusBanner } from '@/modules/wallet-access/WalletStatusBanner';
 *   ...
 *   <DashboardLayout>
 *     <WalletStatusBanner />
 *     ...
 *   </DashboardLayout>
 *
 * IPR Owner: Rohit Tidke | (c) 2026 Intech Research Group
 */

import React from 'react';
import { useWallet } from './useWallet';

const STYLES: Record<string, React.CSSProperties> = {
  warning: {
    background: '#D4924A',
    color: '#2a1a00',
  },
  danger: {
    background: '#C05858',
    color: '#fff',
  },
  info: {
    background: '#4A8AB0',
    color: '#fff',
  },
};

const BASE: React.CSSProperties = {
  padding: '10px 16px',
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  fontFamily: "'Segoe UI', Tahoma, sans-serif",
  fontSize: 14,
  borderRadius: 4,
};

export function WalletStatusBanner(): JSX.Element | null {
  const { banner } = useWallet();
  if (!banner) return null;
  const style: React.CSSProperties = { ...BASE, ...(STYLES[banner.level] || STYLES.info) };
  const onClick = () => {
    if (banner.cta_route) window.location.href = banner.cta_route;
  };
  return (
    <div style={style} role="alert">
      <span>{banner.message}</span>
      {banner.cta_label && banner.cta_route && (
        <button
          type="button"
          onClick={onClick}
          style={{
            background: 'rgba(0,0,0,0.2)',
            color: 'inherit',
            border: '1px solid currentColor',
            padding: '6px 12px',
            borderRadius: 4,
            cursor: 'pointer',
            fontWeight: 600,
          }}
        >
          {banner.cta_label}
        </button>
      )}
    </div>
  );
}
