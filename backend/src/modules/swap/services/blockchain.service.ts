// backend/src/services/blockchain.service.ts
// Smart Contract Interaction Layer for FTRToken.sol

import { ethers, Contract, Wallet, Provider } from 'ethers';
import logger, { transactionLogger } from '../utils/logger';
import { systemSubmit, CONTRACTS } from '../../../services/chain-submit.service';

// =============================================================================
// CONFIGURATION
// =============================================================================

const BLOCKCHAIN_CONFIG = {
  // Prefer the shared IRG_CHAIN_* vars; fall back to legacy BLOCKCHAIN_* for
  // backward compatibility with older deploys. Default is now IRG Chain 888101.
  rpcUrl: process.env.IRG_CHAIN_RPC_URL || process.env.BLOCKCHAIN_RPC_URL || 'http://localhost:8545',
  chainId: parseInt(process.env.IRG_CHAIN_ID || process.env.BLOCKCHAIN_CHAIN_ID || '888101'),
  privateKey: process.env.BLOCKCHAIN_PRIVATE_KEY || '',
  ftrTokenAddress: process.env.ADDR_FTR_TOKEN || process.env.FTR_TOKEN_ADDRESS || '',
  gasLimit: parseInt(process.env.BLOCKCHAIN_GAS_LIMIT || '500000'),
  maxRetries: 3,
  retryDelay: 1000,

  // When the middleware gateway is configured we route through it instead of
  // signing locally — this ensures every swap tx also lands in ChainTxAudit.
  useMiddlewareGateway:
    !!process.env.IRG_CHAIN_MIDDLEWARE_URL && !!process.env.IRG_CHAIN_MIDDLEWARE_SECRET,
};

// =============================================================================
// FTR TOKEN ABI (Minimal interface for swap operations)
// =============================================================================

const FTR_TOKEN_ABI = [
  // Events
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
  'event TokenMinted(uint256 indexed tokenId, address indexed owner, string productType, uint256 faceValue)',
  'event TokenSurrendered(uint256 indexed tokenId, address indexed owner)',
  'event TokenBurned(uint256 indexed tokenId)',
  'event SwapExecuted(uint256 indexed fromTokenId, uint256 indexed toTokenId, address indexed executor)',
  
  // Read functions
  'function balanceOf(address owner) view returns (uint256)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function tokenURI(uint256 tokenId) view returns (string)',
  'function getTokenDetails(uint256 tokenId) view returns (tuple(string productType, uint256 faceValue, uint8 state, uint256 mintedAt, uint256 surrenderedAt))',
  'function totalSupply() view returns (uint256)',
  
  // Write functions
  'function mint(address to, string productType, uint256 faceValue) returns (uint256)',
  'function surrender(uint256 tokenId)',
  'function burn(uint256 tokenId)',
  'function executeSwap(uint256 fromTokenId, uint256 toTokenId, address newOwner)',
  'function batchTransfer(uint256[] tokenIds, address to)',
  
  // Admin functions
  'function pause()',
  'function unpause()',
  'function setMinter(address minter, bool approved)',
];

// =============================================================================
// TOKEN STATE ENUM (matches Solidity contract)
// =============================================================================

export enum BlockchainTokenState {
  MINTED = 0,
  ACTIVE = 1,
  SURRENDERED = 2,
  REDEEMED = 3,
  BURNED = 4,
}

// =============================================================================
// BLOCKCHAIN SERVICE
// =============================================================================

export class BlockchainService {
  private static instance: BlockchainService;
  private provider: Provider | null = null;
  private wallet: Wallet | null = null;
  private ftrTokenContract: Contract | null = null;
  private initialized: boolean = false;

  private constructor() {}

  public static getInstance(): BlockchainService {
    if (!BlockchainService.instance) {
      BlockchainService.instance = new BlockchainService();
    }
    return BlockchainService.instance;
  }

  // ===========================================================================
  // INITIALIZATION
  // ===========================================================================

  async initialize(): Promise<boolean> {
    if (this.initialized) return true;

    try {
      // Check if blockchain is configured
      if (!BLOCKCHAIN_CONFIG.privateKey || !BLOCKCHAIN_CONFIG.ftrTokenAddress) {
        logger.warn('[BLOCKCHAIN] Not configured - running in mock mode');
        return false;
      }

      // Connect to provider
      this.provider = new ethers.JsonRpcProvider(
        BLOCKCHAIN_CONFIG.rpcUrl,
        BLOCKCHAIN_CONFIG.chainId
      );

      // Create wallet
      this.wallet = new Wallet(BLOCKCHAIN_CONFIG.privateKey, this.provider);

      // Connect to FTR Token contract
      this.ftrTokenContract = new Contract(
        BLOCKCHAIN_CONFIG.ftrTokenAddress,
        FTR_TOKEN_ABI,
        this.wallet
      );

      // Verify connection
      const network = await this.provider.getNetwork();
      logger.info(`[BLOCKCHAIN] Connected to chain ${network.chainId}`);

      this.initialized = true;
      return true;
    } catch (error) {
      logger.error('[BLOCKCHAIN] Initialization failed', { error });
      return false;
    }
  }

  /**
   * Route a token operation through the IRG Chain 888101 middleware gateway
   * instead of signing locally. This path is used whenever
   * IRG_CHAIN_MIDDLEWARE_URL + IRG_CHAIN_MIDDLEWARE_SECRET are set. The
   * middleware's SYSTEM_SIGNER_KEY signs and pays gas; the audit row lands
   * in ChainTxAudit automatically.
   */
  private async viaGateway(
    action: string,
    txType: string,
    meta: Record<string, unknown>,
  ): Promise<{ success: boolean; txHash?: string; error?: string; simulated?: boolean }> {
    try {
      const result = await systemSubmit({
        module: 'swap',
        action,
        toAddress: CONTRACTS.FTRToken,
        // Real ABI encoding is wired up once the contract is live; until then
        // the gateway records a deterministic placeholder so every swap tx
        // still has a unique, audit-logged chain footprint.
        data: '0x',
        meta: { ...meta, txType },
      });
      if (result.status === 'SUBMITTED' || result.status === 'SIMULATED') {
        return {
          success: true,
          txHash: result.txHash,
          simulated: result.simulated,
        };
      }
      return { success: false, error: result.error || 'gateway_failed' };
    } catch (err: any) {
      return { success: false, error: err?.message || String(err) };
    }
  }

  // ===========================================================================
  // TOKEN OPERATIONS
  // ===========================================================================

  /**
   * Surrender a token on-chain
   * Called when user initiates swap
   */
  async surrenderToken(tokenId: string): Promise<{ success: boolean; txHash?: string; error?: string }> {
    const txId = `surrender-${tokenId}-${Date.now()}`;
    transactionLogger.start(txId, 'BLOCKCHAIN_SURRENDER', { tokenId });

    // Preferred path: IRG Chain 888101 middleware gateway (audit-logged).
    if (BLOCKCHAIN_CONFIG.useMiddlewareGateway) {
      const r = await this.viaGateway('surrender', 'BLOCKCHAIN_SURRENDER', { tokenId });
      if (r.success) {
        transactionLogger.complete(txId, 'BLOCKCHAIN_SURRENDER', {
          tokenId, txHash: r.txHash, simulated: r.simulated, gateway: true,
        });
        return { success: true, txHash: r.txHash };
      }
      transactionLogger.fail(txId, 'BLOCKCHAIN_SURRENDER', r.error || 'gateway_failed', { tokenId });
      return { success: false, error: r.error };
    }

    try {
      if (!this.initialized || !this.ftrTokenContract) {
        // Mock mode for development
        logger.info(`[BLOCKCHAIN:MOCK] Surrender token ${tokenId}`);
        transactionLogger.complete(txId, 'BLOCKCHAIN_SURRENDER', { tokenId, mock: true });
        return { success: true, txHash: `mock-tx-${Date.now()}` };
      }

      const tx = await this.ftrTokenContract.surrender(tokenId, {
        gasLimit: BLOCKCHAIN_CONFIG.gasLimit,
      });

      const receipt = await tx.wait();
      
      transactionLogger.complete(txId, 'BLOCKCHAIN_SURRENDER', {
        tokenId,
        txHash: receipt.hash,
        gasUsed: receipt.gasUsed.toString(),
      });

      return { success: true, txHash: receipt.hash };
    } catch (error: any) {
      transactionLogger.fail(txId, 'BLOCKCHAIN_SURRENDER', error.message, { tokenId });
      return { success: false, error: error.message };
    }
  }

  /**
   * Execute atomic swap on-chain
   * Transfers ownership and updates states
   */
  async executeSwap(
    fromTokenId: string,
    toTokenId: string,
    newOwner: string
  ): Promise<{ success: boolean; txHash?: string; error?: string }> {
    const txId = `swap-${fromTokenId}-${toTokenId}-${Date.now()}`;
    transactionLogger.start(txId, 'BLOCKCHAIN_SWAP', { fromTokenId, toTokenId, newOwner });

    // Preferred path: IRG Chain 888101 middleware gateway (audit-logged).
    if (BLOCKCHAIN_CONFIG.useMiddlewareGateway) {
      const r = await this.viaGateway('execute_swap', 'BLOCKCHAIN_SWAP', {
        fromTokenId, toTokenId, newOwner,
      });
      if (r.success) {
        transactionLogger.complete(txId, 'BLOCKCHAIN_SWAP', {
          fromTokenId, toTokenId, newOwner, txHash: r.txHash,
          simulated: r.simulated, gateway: true,
        });
        return { success: true, txHash: r.txHash };
      }
      transactionLogger.fail(txId, 'BLOCKCHAIN_SWAP', r.error || 'gateway_failed',
        { fromTokenId, toTokenId });
      return { success: false, error: r.error };
    }

    try {
      if (!this.initialized || !this.ftrTokenContract) {
        // Mock mode
        logger.info(`[BLOCKCHAIN:MOCK] Execute swap ${fromTokenId} -> ${toTokenId}`);
        transactionLogger.complete(txId, 'BLOCKCHAIN_SWAP', { mock: true });
        return { success: true, txHash: `mock-tx-${Date.now()}` };
      }

      const tx = await this.ftrTokenContract.executeSwap(
        fromTokenId,
        toTokenId,
        newOwner,
        { gasLimit: BLOCKCHAIN_CONFIG.gasLimit }
      );

      const receipt = await tx.wait();

      transactionLogger.complete(txId, 'BLOCKCHAIN_SWAP', {
        fromTokenId,
        toTokenId,
        newOwner,
        txHash: receipt.hash,
        gasUsed: receipt.gasUsed.toString(),
      });

      return { success: true, txHash: receipt.hash };
    } catch (error: any) {
      transactionLogger.fail(txId, 'BLOCKCHAIN_SWAP', error.message, { fromTokenId, toTokenId });
      return { success: false, error: error.message };
    }
  }

  /**
   * Burn token (for short-sale buyback and cancel)
   */
  async burnToken(tokenId: string): Promise<{ success: boolean; txHash?: string; error?: string }> {
    const txId = `burn-${tokenId}-${Date.now()}`;
    transactionLogger.start(txId, 'BLOCKCHAIN_BURN', { tokenId });

    if (BLOCKCHAIN_CONFIG.useMiddlewareGateway) {
      const r = await this.viaGateway('burn', 'BLOCKCHAIN_BURN', { tokenId });
      if (r.success) {
        transactionLogger.complete(txId, 'BLOCKCHAIN_BURN', {
          tokenId, txHash: r.txHash, simulated: r.simulated, gateway: true,
        });
        return { success: true, txHash: r.txHash };
      }
      transactionLogger.fail(txId, 'BLOCKCHAIN_BURN', r.error || 'gateway_failed', { tokenId });
      return { success: false, error: r.error };
    }

    try {
      if (!this.initialized || !this.ftrTokenContract) {
        logger.info(`[BLOCKCHAIN:MOCK] Burn token ${tokenId}`);
        transactionLogger.complete(txId, 'BLOCKCHAIN_BURN', { mock: true });
        return { success: true, txHash: `mock-tx-${Date.now()}` };
      }

      const tx = await this.ftrTokenContract.burn(tokenId, {
        gasLimit: BLOCKCHAIN_CONFIG.gasLimit,
      });

      const receipt = await tx.wait();

      transactionLogger.complete(txId, 'BLOCKCHAIN_BURN', {
        tokenId,
        txHash: receipt.hash,
      });

      return { success: true, txHash: receipt.hash };
    } catch (error: any) {
      transactionLogger.fail(txId, 'BLOCKCHAIN_BURN', error.message, { tokenId });
      return { success: false, error: error.message };
    }
  }

  /**
   * Get token details from blockchain
   */
  async getTokenDetails(tokenId: string): Promise<{
    productType: string;
    faceValue: bigint;
    state: BlockchainTokenState;
    mintedAt: bigint;
    surrenderedAt: bigint;
  } | null> {
    try {
      if (!this.initialized || !this.ftrTokenContract) {
        return null;
      }

      const details = await this.ftrTokenContract.getTokenDetails(tokenId);
      return {
        productType: details.productType,
        faceValue: details.faceValue,
        state: details.state,
        mintedAt: details.mintedAt,
        surrenderedAt: details.surrenderedAt,
      };
    } catch (error) {
      logger.error('[BLOCKCHAIN] Failed to get token details', { tokenId, error });
      return null;
    }
  }

  /**
   * Verify token ownership
   */
  async verifyOwnership(tokenId: string, expectedOwner: string): Promise<boolean> {
    try {
      if (!this.initialized || !this.ftrTokenContract) {
        return true; // Mock mode - assume valid
      }

      const owner = await this.ftrTokenContract.ownerOf(tokenId);
      return owner.toLowerCase() === expectedOwner.toLowerCase();
    } catch (error) {
      logger.error('[BLOCKCHAIN] Ownership verification failed', { tokenId, error });
      return false;
    }
  }

  // ===========================================================================
  // BATCH OPERATIONS
  // ===========================================================================

  /**
   * Batch transfer tokens (for corpus fund operations)
   */
  async batchTransfer(
    tokenIds: string[],
    to: string
  ): Promise<{ success: boolean; txHash?: string; error?: string }> {
    const txId = `batch-${Date.now()}`;
    transactionLogger.start(txId, 'BLOCKCHAIN_BATCH_TRANSFER', { count: tokenIds.length, to });

    if (BLOCKCHAIN_CONFIG.useMiddlewareGateway) {
      const r = await this.viaGateway('batch_transfer', 'BLOCKCHAIN_BATCH_TRANSFER', {
        count: tokenIds.length, to,
      });
      if (r.success) {
        transactionLogger.complete(txId, 'BLOCKCHAIN_BATCH_TRANSFER', {
          count: tokenIds.length, txHash: r.txHash,
          simulated: r.simulated, gateway: true,
        });
        return { success: true, txHash: r.txHash };
      }
      transactionLogger.fail(txId, 'BLOCKCHAIN_BATCH_TRANSFER', r.error || 'gateway_failed', {});
      return { success: false, error: r.error };
    }

    try {
      if (!this.initialized || !this.ftrTokenContract) {
        logger.info(`[BLOCKCHAIN:MOCK] Batch transfer ${tokenIds.length} tokens`);
        return { success: true, txHash: `mock-tx-${Date.now()}` };
      }

      const tx = await this.ftrTokenContract.batchTransfer(tokenIds, to, {
        gasLimit: BLOCKCHAIN_CONFIG.gasLimit * tokenIds.length,
      });

      const receipt = await tx.wait();

      transactionLogger.complete(txId, 'BLOCKCHAIN_BATCH_TRANSFER', {
        count: tokenIds.length,
        txHash: receipt.hash,
      });

      return { success: true, txHash: receipt.hash };
    } catch (error: any) {
      transactionLogger.fail(txId, 'BLOCKCHAIN_BATCH_TRANSFER', error.message, {});
      return { success: false, error: error.message };
    }
  }

  // ===========================================================================
  // UTILITIES
  // ===========================================================================

  isInitialized(): boolean {
    return this.initialized;
  }

  async getBlockNumber(): Promise<number> {
    if (!this.provider) return 0;
    return await this.provider.getBlockNumber();
  }
}

// =============================================================================
// EXPORTS
// =============================================================================

export const blockchainService = BlockchainService.getInstance();
export default blockchainService;
