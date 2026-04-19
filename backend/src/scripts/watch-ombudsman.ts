/**
 * Ombudsman event listener (FTR side).
 *
 * Long-lived sidecar. Subscribes to OmbudsmanOrderIssued events on the
 * WalletRecoveryEvents contract via a JSON-RPC provider and calls
 * walletService.executeOmbudsmanOrder for each matching order.
 *
 * Run as: node dist/scripts/watch-ombudsman.js
 * Env vars required:
 *   IRG_CHAIN_RPC_URL
 *   ADDR_WALLET_RECOVERY_EVENTS
 *
 * IPR Owner: Rohit Tidke | (c) 2026 Intech Research Group
 */

import { ethers } from 'ethers';

import * as wallet from '../modules/wallet-access/services/wallet.service';

const EVENT_ABI = [
  'event OmbudsmanOrderIssued(bytes32 indexed caseId, bytes32 indexed orderHash, uint8 disposition, address indexed targetWallet, bytes32 actionPayload, uint256 issuedAt)',
];

const DISPOSITION_MAP: Record<number, 'APPROVE' | 'APPROVE_MODIFIED' | 'REJECT' | 'REMAND' | 'ESCALATE_COURT'> = {
  0: 'APPROVE',
  1: 'APPROVE_MODIFIED',
  2: 'REJECT',
  3: 'REMAND',
  4: 'ESCALATE_COURT',
};

async function main() {
  const rpc = process.env.IRG_CHAIN_RPC_URL;
  const address = process.env.ADDR_WALLET_RECOVERY_EVENTS;
  if (!rpc || !address) {
    console.error('IRG_CHAIN_RPC_URL and ADDR_WALLET_RECOVERY_EVENTS must be set.');
    process.exit(1);
  }
  const provider = new ethers.JsonRpcProvider(rpc);
  const contract = new ethers.Contract(address, EVENT_ABI, provider);

  console.info(`[watch-ombudsman] listening on ${address} via ${rpc}`);

  contract.on('OmbudsmanOrderIssued', async (caseIdBytes: string, orderHashBytes: string, disposition: bigint, _target: string, _payload: string, _issuedAt: bigint, event: any) => {
    try {
      // caseId bytes32 is utf-8-encoded Prisma ID, right-padded with zeros.
      const raw = ethers.getBytes(caseIdBytes);
      let end = raw.length;
      while (end > 0 && raw[end - 1] === 0) end--;
      const caseId = new TextDecoder().decode(raw.slice(0, end));

      const disp = DISPOSITION_MAP[Number(disposition)] || 'REMAND';
      const txHash = event?.log?.transactionHash || event?.transactionHash || '';

      // caseId may carry the "ownership:" prefix for an ownership transfer
      // event. Currently executeOmbudsmanOrder only handles recovery cases;
      // ownership handling lives in a separate service method (added here
      // as a future hook for the Ombudsman team).
      if (caseId.startsWith('ownership:')) {
        console.info(`[watch-ombudsman] ownership case event seen (caseId=${caseId}); wiring TBD`);
        return;
      }

      await wallet.executeOmbudsmanOrder({
        caseId,
        orderHash: orderHashBytes,
        orderTxHash: txHash,
        disposition: disp,
      });
      console.info(`[watch-ombudsman] processed case ${caseId} disposition=${disp}`);
    } catch (err: any) {
      console.error('[watch-ombudsman] processing failed:', err?.message || err);
    }
  });

  // Keep the process alive
  process.on('SIGINT', () => {
    console.info('[watch-ombudsman] shutting down');
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('watch-ombudsman fatal:', err);
  process.exit(1);
});
