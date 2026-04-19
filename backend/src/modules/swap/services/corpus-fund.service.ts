// ═══════════════════════════════════════════════════════════════════════════════
// IRG SWAP SYSTEM — CORPUS FUND SERVICE (v7.0 bridge-delegated)
// ═══════════════════════════════════════════════════════════════════════════════
//
// Previously this file owned corpus-fund accounting locally via Prisma. As of
// gov_v3 v3.1 / FTR v7, corpus operations for Minter_CF instances are the
// responsibility of the canonical IRG PAA module in gov_v3. FTR's local
// Prisma rows remain as a performance cache + query surface for swap and ROI
// workflows — every mutation is first posted through the PAA bridge and
// only mirrored locally after a successful PAA response.
//
// Public API is preserved so `swap.routes.ts` does not need to change. The
// method bodies are now thin adapters:
//
//     createCorpusFund()          → bridge.createCorpusFund()
//     deposit()                   → bridge.postCollection()
//     processSurrenderReturn()    → bridge.requestPayment()  (recall_compensation)
//     transferToRecallFund()      → bridge.requestPayment()  (ftr_recall_costs)
//     runCorpusSnapshot()         → bridge.listCorpusFunds() + local reconcile
//     getCorpusFund()             → Prisma read
//     getCorpusFundStats()        → Prisma read + bridge enrichment

import { PrismaClient, CorpusStatus } from '@prisma/client';
import { useAuditLog, useValidation } from '../hooks/hep-hooks';
import { CorpusFund } from '../../../shared/types';
import { getPAABridge } from '../../../services/paa-bridge';

const prisma = new PrismaClient();

export class CorpusFundService {
  private static instance: CorpusFundService;
  private auditLog = useAuditLog();
  private validation = useValidation();
  private bridge = getPAABridge({ sourceSystem: 'ftr' });

  private constructor() {}

  public static getInstance(): CorpusFundService {
    if (!CorpusFundService.instance) {
      CorpusFundService.instance = new CorpusFundService();
    }
    return CorpusFundService.instance;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // CREATE CORPUS FUND FOR MINTER
  // ─────────────────────────────────────────────────────────────────────────
  async createCorpusFund(
    minterId: string,
    initialDeposit: number,
    userId: string,
  ): Promise<{ success: boolean; corpusFund?: CorpusFund; error?: string }> {
    try {
      const minter = await prisma.minter.findUnique({
        where: { id: minterId },
        include: { corpusFund: true },
      });
      if (!minter) return { success: false, error: 'Minter not found.' };
      if (minter.corpusFund) {
        return { success: false, error: 'Corpus fund already exists for this minter.' };
      }

      // 1. Register on the canonical PAA first.
      const currency = 'USD';
      const paaCfId = `cf_minter_${minter.id}`;
      const paaResult = await this.bridge.createCorpusFund({
        id: paaCfId,
        cfType: 'Minter_CF',
        name: `Minter CF — ${(minter as any).code || minter.id}`,
        countryCode: (minter as any).countryCode || 'GLOBAL',
        ownerId: minter.id,
        primaryCurrency: currency as any,
        isMultiCurrencyAccount: false,
        balances: [
          { currency: currency as any, balance: initialDeposit, lastUpdated: new Date().toISOString() },
        ],
      });

      if (!paaResult.ok) {
        return { success: false, error: `PAA rejected CF creation: ${paaResult.error}` };
      }

      // 2. Mirror into Prisma. Local id == PAA id for joinability.
      const corpus = await prisma.corpusFund.create({
        data: {
          id: paaCfId,
          minterId,
          totalBalance: initialDeposit,
          perUnitValue: 0,
          outstandingUnits: 0,
          marketMakerLimit: initialDeposit * 0.5,
          status: CorpusStatus.ACTIVE,
        },
        include: { minter: true },
      });

      await this.auditLog.record(userId, 'corpus.created', {
        minterId, corpusFundId: corpus.id, initialDeposit, paaCfId,
      });
      return { success: true, corpusFund: corpus as unknown as CorpusFund };
    } catch (err: any) {
      return { success: false, error: err?.message || 'Unknown error' };
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // DEPOSIT TO CORPUS FUND
  // ─────────────────────────────────────────────────────────────────────────
  async deposit(
    corpusFundId: string,
    amount: number,
    userId: string,
  ): Promise<{ success: boolean; newBalance?: number; paaTxId?: string; error?: string }> {
    try {
      const corpus = await prisma.corpusFund.findUnique({ where: { id: corpusFundId } });
      if (!corpus) return { success: false, error: 'Corpus fund not found.' };

      const paaResult = await this.bridge.postCollection({
        category: 'irg_ftr_sale',
        amount,
        currency: 'USD',
        fromAccount: `minter:${corpus.minterId}`,
        sourceRef: `ftr-deposit-${corpusFundId}-${Date.now()}`,
        notes: `FTR deposit on corpus fund ${corpusFundId}`,
      });
      if (!paaResult.ok || !paaResult.data?.ok) {
        return {
          success: false,
          error: (paaResult.data as any)?.validation?.errors?.[0]?.message
                 || paaResult.error || 'PAA rejected deposit',
        };
      }
      const paaTx = paaResult.data.transaction;

      const updated = await prisma.corpusFund.update({
        where: { id: corpusFundId },
        data: { totalBalance: { increment: amount } },
      });

      await this.auditLog.record(userId, 'corpus.deposit', {
        corpusFundId, amount, paaTxId: paaTx.id,
      });
      return { success: true, newBalance: Number(updated.totalBalance), paaTxId: paaTx.id };
    } catch (err: any) {
      return { success: false, error: err?.message || 'Unknown error' };
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PROCESS SURRENDER RETURN
  // ─────────────────────────────────────────────────────────────────────────
  async processSurrenderReturn(
    minterId: string,
    unitsSurrendered: number,
    userId: string,
  ): Promise<{ success: boolean; amountReturned?: number; paaTxId?: string; error?: string }> {
    try {
      const corpus = await prisma.corpusFund.findUnique({ where: { minterId } });
      if (!corpus) return { success: false, error: 'Corpus fund not found.' };
      if (corpus.outstandingUnits < unitsSurrendered) {
        return { success: false, error: 'Insufficient outstanding units.' };
      }

      const amountReturned = unitsSurrendered * Number(corpus.perUnitValue);

      const paaResult = await this.bridge.requestPayment({
        category: 'recall_compensation',
        amount: amountReturned,
        currency: 'USD',
        fromAccount: corpus.id,
        sourceRef: `ftr-surrender-${minterId}-${Date.now()}`,
        notes: `FTR surrender return: ${unitsSurrendered} units`,
      });
      if (!paaResult.ok || !paaResult.data?.ok) {
        return {
          success: false,
          error: (paaResult.data as any)?.validation?.errors?.[0]?.message
                 || paaResult.error || 'PAA rejected surrender return',
        };
      }
      const paaTx = paaResult.data.transaction;

      await prisma.corpusFund.update({
        where: { id: corpus.id },
        data: { outstandingUnits: { decrement: unitsSurrendered } },
      });
      await this.auditLog.record(userId, 'corpus.surrender', {
        minterId, unitsSurrendered, amountReturned, paaTxId: paaTx.id,
      });
      return { success: true, amountReturned, paaTxId: paaTx.id };
    } catch (err: any) {
      return { success: false, error: err?.message || 'Unknown error' };
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // TRANSFER TO RECALL FUND
  // ─────────────────────────────────────────────────────────────────────────
  async transferToRecallFund(
    minterId: string,
    userId: string,
  ): Promise<{ success: boolean; amountTransferred?: number; paaTxId?: string; error?: string }> {
    try {
      const corpus = await prisma.corpusFund.findUnique({ where: { minterId } });
      if (!corpus) return { success: false, error: 'Corpus fund not found.' };
      if (corpus.status !== CorpusStatus.ACTIVE) {
        return { success: false, error: `Corpus fund is ${corpus.status}.` };
      }

      const amount = Number(corpus.totalBalance);
      if (amount <= 0) return { success: false, error: 'Nothing to transfer.' };

      const paaResult = await this.bridge.requestPayment({
        category: 'ftr_recall_costs',
        amount,
        currency: 'USD',
        fromAccount: corpus.id,
        sourceRef: `ftr-recall-transfer-${minterId}-${Date.now()}`,
        notes: `Full balance transfer to recall fund for minter ${minterId}`,
      });
      if (!paaResult.ok || !paaResult.data?.ok) {
        return {
          success: false,
          error: (paaResult.data as any)?.validation?.errors?.[0]?.message
                 || paaResult.error || 'PAA rejected recall transfer',
        };
      }
      const paaTx = paaResult.data.transaction;

      await prisma.corpusFund.update({
        where: { id: corpus.id },
        data: { status: CorpusStatus.TRANSFERRED as any },
      });
      await this.auditLog.record(userId, 'corpus.transferToRecall', {
        minterId, amount, paaTxId: paaTx.id,
      });
      return { success: true, amountTransferred: amount, paaTxId: paaTx.id };
    } catch (err: any) {
      return { success: false, error: err?.message || 'Unknown error' };
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // RUN CORPUS SNAPSHOT — reconciles Prisma mirror against PAA authoritative
  // ─────────────────────────────────────────────────────────────────────────
  async runCorpusSnapshot(): Promise<{ updated: number; errors: string[] }> {
    const errors: string[] = [];
    let updated = 0;
    try {
      const paaRes = await this.bridge.listCorpusFunds({ cfType: 'Minter_CF' });
      if (!paaRes.ok) {
        errors.push(`PAA listCorpusFunds failed: ${paaRes.error}`);
        return { updated, errors };
      }
      const paaCfs = paaRes.data || [];
      for (const paaCf of paaCfs) {
        try {
          const local = await prisma.corpusFund.findUnique({ where: { id: paaCf.id } });
          if (!local) continue;
          const totalUsd = (paaCf.balances || []).reduce(
            (sum, b) => sum + (b.currency === 'USD' ? b.balance : 0), 0);
          if (Math.abs(totalUsd - Number(local.totalBalance)) > 0.01) {
            await prisma.corpusFund.update({
              where: { id: local.id },
              data: { totalBalance: totalUsd },
            });
            updated++;
          }
        } catch (err: any) {
          errors.push(`${paaCf.id}: ${err?.message || 'unknown'}`);
        }
      }
    } catch (err: any) {
      errors.push(err?.message || 'Unknown error');
    }
    return { updated, errors };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // GET CORPUS FUND (by minter id)
  // ─────────────────────────────────────────────────────────────────────────
  async getCorpusFund(minterId: string): Promise<CorpusFund | null> {
    const corpus = await prisma.corpusFund.findUnique({
      where: { minterId },
      include: { minter: true },
    });
    return corpus as unknown as CorpusFund | null;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // GET CORPUS FUND STATS
  // ─────────────────────────────────────────────────────────────────────────
  async getCorpusFundStats(corpusFundId: string): Promise<{
    totalBalance: number;
    shortSaleBalance: number;
    fxReserve: number;
    perUnitValue: number;
    outstandingUnits: number;
    utilizationRate: number;
    recentTransactions: any[];
    paa?: { balances: any[]; status: string };
  } | null> {
    const corpus = await prisma.corpusFund.findUnique({ where: { id: corpusFundId } });
    if (!corpus) return null;

    const recentTransactions = await prisma.transaction.findMany({
      where: { toCorpusFundId: corpusFundId },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });

    const totalBalance = Number(corpus.totalBalance);
    const shortSaleBalance = Number(corpus.shortSaleBalance);
    const utilizationRate = totalBalance > 0 ? shortSaleBalance / totalBalance : 0;

    let paa: { balances: any[]; status: string } | undefined;
    try {
      const paaRes = await this.bridge.getCorpusFund(corpusFundId);
      if (paaRes.ok && paaRes.data) {
        paa = {
          balances: paaRes.data.balances || [],
          status: paaRes.data.isActive ? 'active' : 'inactive',
        };
      }
    } catch { /* bridge unavailable — return local-only */ }

    return {
      totalBalance, shortSaleBalance,
      fxReserve: Number(corpus.fxReserve),
      perUnitValue: Number(corpus.perUnitValue),
      outstandingUnits: corpus.outstandingUnits,
      utilizationRate,
      recentTransactions,
      paa,
    };
  }
}

export const corpusFundService = CorpusFundService.getInstance();
