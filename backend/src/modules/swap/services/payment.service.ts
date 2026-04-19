// ═══════════════════════════════════════════════════════════════════════════════
// IRG SWAP SYSTEM — PAYMENT SERVICE (v7.0 bridge-delegated)
// ═══════════════════════════════════════════════════════════════════════════════
//
// Swap settlements, corpus P/L adjustments, FX adjustments and fee routing
// all go through the canonical IRG PAA module via the bridge. FTR's local
// `Transaction` rows stay as a query cache for swap-specific UIs, but the
// book-of-record is the PAA module.
//
// Public API preserved; method bodies are thin adapters.
//
//   processSwapPayment()             → bridge.postCollection + requestPayment legs
//   recordCorpusPnl()                → bridge.creditROI   (positive PnL)
//                                       / requestPayment  (negative PnL)
//   processSurrenderReturnPayment()  → bridge.requestPayment (recall_compensation)
//   transferToRecall()               → bridge.requestPayment (ftr_recall_costs)
//   getTransactionHistory()          → bridge.listTransactions + Prisma union
//   getPaymentSummary()              → bridge.getDashboardMetrics + Prisma union

import { PrismaClient, TransactionType, TransactionStatus } from '@prisma/client';
import { useDoubleEntry, useAuditLog } from '../hooks/hep-hooks';
import { Transaction } from '../../../shared/types';
import { getPAABridge } from '../../../services/paa-bridge';

const prisma = new PrismaClient();

export class PaymentService {
  private static instance: PaymentService;
  private auditLog = useAuditLog();
  private bridge = getPAABridge({ sourceSystem: 'ftr' });

  private constructor() {}

  public static getInstance(): PaymentService {
    if (!PaymentService.instance) {
      PaymentService.instance = new PaymentService();
    }
    return PaymentService.instance;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PROCESS SWAP PAYMENT — two-leg flow through PAA
  //
  //   Leg A:  requested-minter corpus → initiator  (SWAP_SETTLEMENT)
  //   Leg B:  system support charges  (SYSTEM_CHARGE)
  //
  // Each leg carries the swapId as its sourceRef so PAA can group them in
  // its audit log, and both legs use a deterministic idempotency key so
  // retries don't double-post.
  // ─────────────────────────────────────────────────────────────────────────
  async processSwapPayment(
    swapId: string,
    offeredRate: number,
    requestedRate: number,
    fxRate: number = 1,
  ): Promise<{ success: boolean; transactions?: Transaction[]; error?: string }> {
    const doubleEntry = useDoubleEntry();

    try {
      const swap = await prisma.swapRequest.findUnique({
        where: { id: swapId },
        include: {
          initiator: true,
          requestedMinter: { include: { corpusFund: true } },
        },
      });
      if (!swap) return { success: false, error: 'Swap not found.' };

      const settlementAmount = Number(swap.amount) * requestedRate * fxRate;
      const feeRate = 0.005; // 0.5% support charge
      const feeAmount = settlementAmount * feeRate;

      // Leg A — settlement outflow from requested minter's CF
      const legA = await this.bridge.requestPayment({
        category: 'irg_ftr_sale',
        amount: settlementAmount,
        currency: 'USD',
        fromAccount: swap.requestedMinter?.corpusFund?.id || `minter:${swap.requestedMinterId}`,
        sourceRef: `swap-${swapId}-settlement`,
        notes: `Swap ${swapId} settlement @${requestedRate}`,
      });
      if (!legA.ok || !legA.data?.ok) {
        return {
          success: false,
          error: (legA.data as any)?.validation?.errors?.[0]?.message
                 || legA.error || 'PAA rejected settlement leg',
        };
      }

      // Leg B — system support charge inflow
      const legB = await this.bridge.postCollection({
        category: 'system_support_charges',
        amount: feeAmount,
        currency: 'USD',
        fromAccount: `swap-fee:${swapId}`,
        sourceRef: `swap-${swapId}-fee`,
        notes: `Swap ${swapId} system support charge @${feeRate}`,
      });
      if (!legB.ok || !legB.data?.ok) {
        // Leg A already accepted; flag reconciliation but don't roll-back here.
        await this.auditLog.record('system', 'swap.payment.partialFailure', {
          swapId, legA: legA.data?.transaction?.id, legBError: legB.error,
        });
      }

      // Mirror both legs as local Prisma rows for the swap UI
      const [txSettlement, txFee] = await Promise.all([
        prisma.transaction.create({
          data: {
            id: legA.data.transaction.id,
            type: TransactionType.SWAP_SETTLEMENT,
            amount: settlementAmount,
            status: TransactionStatus.PENDING,
            fromMinterId: swap.requestedMinterId,
            toMinterId: swap.initiatorId,
            swapRequestId: swapId,
            toCorpusFundId: swap.requestedMinter?.corpusFund?.id || null,
            metadata: { paaTxId: legA.data.transaction.id, paaStatus: legA.data.transaction.status },
          },
        }).catch(() => null),
        legB.ok && legB.data?.ok
          ? prisma.transaction.create({
              data: {
                id: legB.data.transaction.id,
                type: TransactionType.SWAP_FEE,
                amount: feeAmount,
                status: TransactionStatus.PENDING,
                swapRequestId: swapId,
                metadata: { paaTxId: legB.data.transaction.id, paaStatus: legB.data.transaction.status },
              },
            }).catch(() => null)
          : Promise.resolve(null),
      ]);

      await doubleEntry.assert([
        { side: 'debit',  amount: settlementAmount, account: 'requested_minter_cf' },
        { side: 'credit', amount: settlementAmount - feeAmount, account: 'initiator' },
        { side: 'credit', amount: feeAmount, account: 'irg_support_fund' },
      ]);

      await this.auditLog.record('system', 'swap.payment.processed', {
        swapId, settlementAmount, feeAmount,
        paaLegA: legA.data.transaction.id,
        paaLegB: legB.ok ? legB.data?.transaction?.id : null,
      });

      return {
        success: true,
        transactions: [txSettlement, txFee].filter(Boolean) as unknown as Transaction[],
      };
    } catch (err: any) {
      return { success: false, error: err?.message || 'Unknown error' };
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // RECORD CORPUS P&L  (positive → creditROI, negative → requestPayment)
  // ─────────────────────────────────────────────────────────────────────────
  async recordCorpusPnl(
    corpusFundId: string,
    pnl: number,
    period: string,
    userId: string,
  ): Promise<{ success: boolean; paaTxId?: string; error?: string }> {
    try {
      let paaResult: any;
      if (pnl >= 0) {
        paaResult = await this.bridge.creditROI({
          cfId: corpusFundId,
          amount: pnl,
          currency: 'USD',
          sourceRef: `ftr-pnl-${corpusFundId}-${period}`,
          period,
          notes: `Corpus P&L ROI credit for ${period}`,
        });
      } else {
        paaResult = await this.bridge.requestPayment({
          category: 'cross_currency_loss',
          amount: Math.abs(pnl),
          currency: 'USD',
          fromAccount: corpusFundId,
          sourceRef: `ftr-pnl-${corpusFundId}-${period}`,
          notes: `Corpus P&L loss for ${period}`,
        });
      }
      if (!paaResult.ok || !paaResult.data?.ok) {
        return {
          success: false,
          error: (paaResult.data as any)?.validation?.errors?.[0]?.message
                 || paaResult.error || 'PAA rejected PnL record',
        };
      }
      await this.auditLog.record(userId, 'corpus.pnl.recorded', {
        corpusFundId, pnl, period, paaTxId: paaResult.data.transaction.id,
      });
      return { success: true, paaTxId: paaResult.data.transaction.id };
    } catch (err: any) {
      return { success: false, error: err?.message || 'Unknown error' };
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PROCESS SURRENDER RETURN PAYMENT
  // ─────────────────────────────────────────────────────────────────────────
  async processSurrenderReturnPayment(
    minterId: string,
    amount: number,
    userId: string,
  ): Promise<{ success: boolean; paaTxId?: string; error?: string }> {
    try {
      const corpus = await prisma.corpusFund.findUnique({ where: { minterId } });
      if (!corpus) return { success: false, error: 'Corpus fund not found.' };

      const paaResult = await this.bridge.requestPayment({
        category: 'recall_compensation',
        amount,
        currency: 'USD',
        fromAccount: corpus.id,
        sourceRef: `ftr-surrender-payment-${minterId}-${Date.now()}`,
        notes: `FTR surrender return payment for minter ${minterId}`,
      });
      if (!paaResult.ok || !paaResult.data?.ok) {
        return {
          success: false,
          error: (paaResult.data as any)?.validation?.errors?.[0]?.message
                 || paaResult.error || 'PAA rejected surrender payment',
        };
      }
      await this.auditLog.record(userId, 'payment.surrender', {
        minterId, amount, paaTxId: paaResult.data.transaction.id,
      });
      return { success: true, paaTxId: paaResult.data.transaction.id };
    } catch (err: any) {
      return { success: false, error: err?.message || 'Unknown error' };
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // TRANSFER TO RECALL FUND
  // ─────────────────────────────────────────────────────────────────────────
  async transferToRecall(
    minterId: string,
    amount: number,
    userId: string,
  ): Promise<{ success: boolean; paaTxId?: string; error?: string }> {
    try {
      const corpus = await prisma.corpusFund.findUnique({ where: { minterId } });
      if (!corpus) return { success: false, error: 'Corpus fund not found.' };

      const paaResult = await this.bridge.requestPayment({
        category: 'ftr_recall_costs',
        amount,
        currency: 'USD',
        fromAccount: corpus.id,
        sourceRef: `ftr-recall-transfer-payment-${minterId}-${Date.now()}`,
        notes: `FTR recall transfer for minter ${minterId}`,
      });
      if (!paaResult.ok || !paaResult.data?.ok) {
        return {
          success: false,
          error: (paaResult.data as any)?.validation?.errors?.[0]?.message
                 || paaResult.error || 'PAA rejected recall transfer',
        };
      }
      await this.auditLog.record(userId, 'payment.recallTransfer', {
        minterId, amount, paaTxId: paaResult.data.transaction.id,
      });
      return { success: true, paaTxId: paaResult.data.transaction.id };
    } catch (err: any) {
      return { success: false, error: err?.message || 'Unknown error' };
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // GET TRANSACTION HISTORY — Prisma local + PAA enrichment
  // ─────────────────────────────────────────────────────────────────────────
  async getTransactionHistory(
    minterId: string,
    limit: number = 50,
    offset: number = 0,
  ): Promise<Transaction[]> {
    const local = await prisma.transaction.findMany({
      where: { OR: [{ toMinterId: minterId }, { fromMinterId: minterId }] },
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
    });

    // Enrich status from canonical PAA where possible
    try {
      const paaRes = await this.bridge.listTransactions({ sourceSystem: 'ftr' });
      if (paaRes.ok && paaRes.data) {
        const byId = new Map(paaRes.data.map(t => [t.id, t]));
        return local.map(t => {
          const paa = byId.get(t.id);
          if (paa) {
            (t as any).metadata = {
              ...(t.metadata as object || {}),
              paaStatus: paa.status,
              paaApprovals: paa.approvals?.length ?? 0,
            };
          }
          return t;
        }) as unknown as Transaction[];
      }
    } catch { /* local-only fallback */ }

    return local as unknown as Transaction[];
  }

  // ─────────────────────────────────────────────────────────────────────────
  // GET PAYMENT SUMMARY
  // ─────────────────────────────────────────────────────────────────────────
  async getPaymentSummary(
    minterId: string,
    period: '7d' | '30d' | '90d' | '1y' = '30d',
  ): Promise<{
    totalSettlements: number; totalFees: number; totalPnl: number; transactionCount: number;
    paa?: { inflowYTD: number; outflowYTD: number; pending: number };
  }> {
    const now = new Date();
    const days = { '7d': 7, '30d': 30, '90d': 90, '1y': 365 }[period];
    const fromDate = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

    const transactions = await prisma.transaction.findMany({
      where: {
        toMinterId: minterId,
        createdAt: { gte: fromDate },
        status: TransactionStatus.COMPLETED,
      },
    });

    const summary = transactions.reduce(
      (acc, tx) => {
        const amount = Number(tx.amount);
        switch (tx.type) {
          case TransactionType.SWAP_SETTLEMENT: acc.totalSettlements += amount; break;
          case TransactionType.SWAP_FEE:        acc.totalFees += amount; break;
          case TransactionType.SHORT_SALE_PROFIT_LOSS:
          case TransactionType.FX_ADJUSTMENT:   acc.totalPnl += amount; break;
        }
        acc.transactionCount++;
        return acc;
      },
      { totalSettlements: 0, totalFees: 0, totalPnl: 0, transactionCount: 0 },
    );

    let paa;
    try {
      const r = await this.bridge.getDashboardMetrics();
      if (r.ok && r.data) {
        paa = {
          inflowYTD:  (r.data as any).inflowYTD  || 0,
          outflowYTD: (r.data as any).outflowYTD || 0,
          pending:    (r.data as any).transactionsPending || 0,
        };
      }
    } catch { /* swallow */ }

    return { ...summary, paa };
  }
}

export const paymentService = PaymentService.getInstance();
