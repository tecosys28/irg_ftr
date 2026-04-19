/**
 * IRG_FTR MASTER PLATFORM - MAIN ROUTES INDEX v6.0
 * AUDIT FIX: All previously empty routes now implemented
 * TROT REGISTRATION PROTOCOL: Registration module integrated
 * ROI MODULE: Dynamic country-based ROI with consultant justification
 * 
 * IPR Owner: Rohit Tidke | © 2026 Intech Research Group
 */
import { Router } from 'express';

// Core module routes
import consultantRoutes from './consultant.routes';
import redemptionRoutes from './redemption.routes';

// AUDIT FIX: Previously empty routes - now fully implemented
import usersRoutes from './users.routes';
import projectsRoutes from './projects.routes';
import mintersRoutes from './minters.routes';
import adminRoutes from './admin.routes';

// Swap module (v6.0 integrated)
import swapRoutes from '../modules/swap/routes';

// Registration module (TROT Protocol compliant)
import registrationRoutes from '../modules/registration/routes/registration.routes';

// ROI module (Dynamic ROI with consultant justification)
import roiRoutes from '../modules/roi/routes/roi.routes';

// Chain audit sink (callback from IRG Chain 888101 middleware)
import chainRoutes from './chain.routes';

// Wallet access (v2.7 — lifecycle, activation, nominees, devices, recovery,
// ownership transfer, inactivity watchdog, CSV export)
import walletRoutes from '../modules/wallet-access/routes/wallet.routes';
import { walletActivityMiddleware } from '../modules/wallet-access/middleware/activity';

const router = Router();

// ═══════════════════════════════════════════════════════════════════════════════
// CORE MODULE ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// Consultant module
router.use('/partners/consultants', consultantRoutes);

// Redemption module
router.use('/redemption', redemptionRoutes);

// Swap module (v6.0 integrated)
router.use('/swap', swapRoutes);

// Registration module (TROT Protocol compliant - v6.0)
router.use('/registration', registrationRoutes);

// ROI module (Dynamic ROI with consultant justification - v6.0)
router.use('/roi', roiRoutes);

// ═══════════════════════════════════════════════════════════════════════════════
// AUDIT FIX: PREVIOUSLY EMPTY ROUTES - NOW IMPLEMENTED
// ═══════════════════════════════════════════════════════════════════════════════

// User management routes
router.use('/users', usersRoutes);

// Project management routes (integrated with ROI module)
router.use('/projects', projectsRoutes);

// Minter management routes
router.use('/minters', mintersRoutes);

// Admin routes (includes P1 fix: Dynamic ROI per country)
router.use('/admin', adminRoutes);

// IRG Chain 888101 audit sink (middleware callback)
router.use('/chain', chainRoutes);

// Wallet-access (lifecycle, recovery, nominees, devices, ownership transfer).
// Activity middleware sits in front so every authenticated request resets
// the inactivity clock.
router.use('/wallet', walletActivityMiddleware(), walletRoutes);

// ═══════════════════════════════════════════════════════════════════════════════
// HEALTH CHECK
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    version: '6.0.0',
    modules: {
      consultant: 'active',
      rating: 'active',
      redemption: 'active',
      swap: 'active',
      registration: 'active (TROT Protocol)',
      roi: 'active (Dynamic ROI)',
      users: 'active',
      projects: 'active (ROI integrated)',
      minters: 'active',
      admin: 'active',
      chain: 'active (IRG Chain 888101)',
      wallet: 'active (v2.7 wallet lifecycle + recovery)',
    },
  });
});

export default router;
