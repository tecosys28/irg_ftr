/**
 * useWallet() — a starter React hook for the wallet-access API.
 *
 * Wraps the /api/v1/wallet/* endpoints in a single hook. Components
 * can destructure info, banner, devices, nominees, history, and
 * call action functions like activate(), confirmLiveness(), etc.
 *
 * This is a minimal starter. Extend with caching / SWR / react-query
 * as needed by your existing frontend patterns.
 *
 * IPR Owner: Rohit Tidke | (c) 2026 Intech Research Group
 */

import { useCallback, useEffect, useState } from 'react';

const API = '/api/v1';

function authHeaders(): Record<string, string> {
  const t = typeof window !== 'undefined' ? window.localStorage.getItem('authToken') : '';
  return t ? { Authorization: `Token ${t}` } : {};
}

async function apiGet<T>(path: string): Promise<T> {
  const r = await fetch(`${API}${path}`, { headers: { ...authHeaders() } });
  if (!r.ok) throw await r.json().catch(() => ({ error: 'request_failed' }));
  return r.json();
}

async function apiSend<T>(
  path: string,
  body: any,
  method: 'POST' | 'PUT' | 'DELETE' = 'POST',
): Promise<T> {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: body == null ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw await r.json().catch(() => ({ error: 'request_failed' }));
  return r.json();
}

// ─────────────────────────────────────────────────────────────────────────────

export interface WalletInfoDTO {
  address: string;
  chain_id?: number;
  chainId?: number;
  state: string;
  state_label?: string;
  stateLabel?: string;
  blocking_reason?: string;
  blockingReason?: string;
  holder_type?: string;
  holderType?: string;
  legal_entity_name?: string;
  legalEntityName?: string;
  entity_type?: string;
  entityType?: string;
  created_at?: string;
  createdAt?: string;
  activated_at?: string | null;
  activatedAt?: string | null;
  nominee_count?: number;
  nomineeCount?: number;
  nominee_shares_total?: string;
  nomineeSharesTotal?: string;
  active_device_count?: number;
  activeDeviceCount?: number;
  last_activity_at?: string | null;
  lastActivityAt?: string | null;
  is_transactable?: boolean;
  isTransactable?: boolean;
}

export interface BannerDTO {
  level: 'warning' | 'danger' | 'info';
  message: string;
  cta_label: string | null;
  cta_route: string | null;
}

export interface ActivateArgs {
  walletPassword: string;
  seedPhraseWords: string[];
  holderType: 'INDIVIDUAL' | 'LEGAL_PERSON';
  legalEntityName?: string;
  entityType?: string;
  nominees: Array<{
    name: string;
    relationship: string;
    email?: string;
    mobile?: string;
    share_percent: number;
  }>;
  deviceIdHash: string;
  deviceLabel?: string;
  platform?: string;
  termsAccepted: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────

export function useWallet() {
  const [info, setInfo] = useState<WalletInfoDTO | null>(null);
  const [banner, setBanner] = useState<BannerDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [i, b] = await Promise.all([
        apiGet<WalletInfoDTO>('/wallet/info').catch(() => null),
        apiGet<{ banner: BannerDTO | null }>('/wallet/status-banner').catch(() => ({ banner: null })),
      ]);
      setInfo(i);
      setBanner(b?.banner || null);
    } catch (e: any) {
      setError(e?.error || 'load_failed');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const activate = useCallback(
    async (args: ActivateArgs) => {
      const r = await apiSend<WalletInfoDTO>('/wallet/activate', {
        wallet_password: args.walletPassword,
        seed_phrase_words: args.seedPhraseWords,
        holder_type: args.holderType,
        legal_entity_name: args.legalEntityName ?? '',
        entity_type: args.entityType ?? '',
        nominees: args.nominees,
        device_id_hash: args.deviceIdHash,
        device_label: args.deviceLabel ?? '',
        platform: args.platform ?? '',
        terms_accepted: args.termsAccepted,
      });
      await refresh();
      return r;
    },
    [refresh],
  );

  const confirmLiveness = useCallback(async () => {
    const r = await apiSend('/wallet/liveness/confirm', {});
    await refresh();
    return r;
  }, [refresh]);

  const emergencyFreeze = useCallback(
    async (reason: string) => {
      await apiSend('/wallet/freeze', { reason });
      await refresh();
    },
    [refresh],
  );

  const changePassword = useCallback(async (oldPassword: string, newPassword: string) => {
    return apiSend('/wallet/password/change', {
      old_password: oldPassword,
      new_password: newPassword,
    });
  }, []);

  const listNominees = useCallback(() => apiGet<any[]>('/wallet/nominees'), []);
  const updateNominees = useCallback(async (nominees: any[], walletPassword: string) => {
    return apiSend('/wallet/nominees/update', { nominees, wallet_password: walletPassword }, 'PUT');
  }, []);

  const listDevices = useCallback(() => apiGet<any[]>('/wallet/devices'), []);
  const bindDevice = useCallback(
    async (deviceIdHash: string, deviceLabel: string, platform: string, walletPassword: string) => {
      return apiSend('/wallet/devices/bind', {
        device_id_hash: deviceIdHash,
        device_label: deviceLabel,
        platform,
        wallet_password: walletPassword,
      });
    },
    [],
  );
  const revokeDevice = useCallback(async (deviceId: string, walletPassword: string) => {
    return apiSend('/wallet/devices/revoke', { device_id: deviceId, wallet_password: walletPassword });
  }, []);

  const listTransactions = useCallback(
    async (filters: { module?: string; status?: string } = {}) => {
      const qs = new URLSearchParams();
      if (filters.module) qs.set('module', filters.module);
      if (filters.status) qs.set('status', filters.status);
      return apiGet<any[]>(`/wallet/transactions?${qs.toString()}`);
    },
    [],
  );

  const downloadCsv = useCallback(async (filters: { module?: string; status?: string } = {}) => {
    const qs = new URLSearchParams();
    if (filters.module) qs.set('module', filters.module);
    if (filters.status) qs.set('status', filters.status);
    const r = await fetch(`${API}/wallet/transactions/export.csv?${qs.toString()}`, {
      headers: { ...authHeaders() },
    });
    if (!r.ok) throw new Error('download_failed');
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'irg_transactions.csv';
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  const listRecoveryCases = useCallback(() => apiGet<any[]>('/wallet/recovery/cases'), []);
  const cancelRecovery = useCallback(async (caseId: string, reason: string) => {
    return apiSend('/wallet/recovery/cancel', { case_id: caseId, reason });
  }, []);

  const listOwnershipCases = useCallback(() => apiGet<any[]>('/wallet/ownership/cases'), []);
  const initiateOwnershipTransfer = useCallback(
    async (args: {
      incomingParticipantId?: string | null;
      reason: string;
      grounds: string;
      evidenceBundleHash: string;
    }) => {
      return apiSend('/wallet/ownership/initiate', {
        incoming_participant_id: args.incomingParticipantId ?? null,
        reason: args.reason,
        grounds: args.grounds,
        evidence_bundle_hash: args.evidenceBundleHash,
      });
    },
    [],
  );

  return {
    // state
    info,
    banner,
    loading,
    error,
    // actions
    refresh,
    activate,
    confirmLiveness,
    emergencyFreeze,
    changePassword,
    listNominees,
    updateNominees,
    listDevices,
    bindDevice,
    revokeDevice,
    listTransactions,
    downloadCsv,
    listRecoveryCases,
    cancelRecovery,
    listOwnershipCases,
    initiateOwnershipTransfer,
  };
}
