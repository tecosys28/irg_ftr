/**
 * IRG Chain 888101 — multi-channel notifications (FTR side).
 *
 * Mirrors wallet_access/notifications.py in IRG_GDP. Channels: EMAIL
 * (always logged in dev; plug in SMTP/SendGrid in prod), WHATSAPP,
 * SMS and PUSH are all stubs — plug in your provider by replacing
 * the body of the corresponding adapter.
 *
 * Safety: refuses to render a template whose context keys contain
 * secret-looking substrings. Plaintext seed phrases, private keys,
 * or wallet passwords must never be sent on any channel.
 *
 * IPR Owner: Rohit Tidke | (c) 2026 Intech Research Group
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// ─────────────────────────────────────────────────────────────────────────────
// EVENT CATALOG
// ─────────────────────────────────────────────────────────────────────────────

type Channel = 'EMAIL' | 'WHATSAPP' | 'SMS' | 'PUSH';

interface EventCfg {
  channels: Channel[];
  subject: string;
  urgency: 'normal' | 'high' | 'critical';
}

const EVENTS: Record<string, EventCfg> = {
  'wallet.created': {
    channels: ['EMAIL', 'WHATSAPP'],
    subject: 'Your IRG wallet has been created',
    urgency: 'normal',
  },
  'wallet.activation_required': {
    channels: ['EMAIL', 'PUSH'],
    subject: 'Action needed: activate your IRG wallet',
    urgency: 'normal',
  },
  'wallet.activated': {
    channels: ['EMAIL', 'WHATSAPP'],
    subject: 'Your IRG wallet is now active',
    urgency: 'normal',
  },
  'wallet.transaction_executed': {
    channels: ['EMAIL', 'PUSH'],
    subject: 'IRG transaction confirmed',
    urgency: 'normal',
  },
  'wallet.unusual_activity': {
    channels: ['EMAIL', 'WHATSAPP', 'SMS', 'PUSH'],
    subject: 'Security alert on your IRG wallet',
    urgency: 'high',
  },
  'wallet.inactivity_prompt': {
    channels: ['EMAIL', 'WHATSAPP', 'PUSH'],
    subject: 'IRG: we have not seen you in a year',
    urgency: 'normal',
  },
  'wallet.inactivity_reminder': {
    channels: ['EMAIL', 'WHATSAPP', 'SMS', 'PUSH'],
    subject: 'IRG: please confirm your IRG wallet is still active',
    urgency: 'high',
  },
  'wallet.inactivity_nominee_alert': {
    channels: ['EMAIL', 'WHATSAPP', 'SMS'],
    subject: 'IRG: a wallet you are a nominee on has been silent',
    urgency: 'high',
  },
  'recovery.initiated': {
    channels: ['EMAIL', 'WHATSAPP', 'SMS', 'PUSH'],
    subject: 'URGENT: Recovery initiated on your IRG wallet',
    urgency: 'critical',
  },
  'recovery.approved': {
    channels: ['EMAIL', 'WHATSAPP'],
    subject: 'IRG wallet recovery approved',
    urgency: 'high',
  },
  'recovery.executed': {
    channels: ['EMAIL', 'WHATSAPP', 'SMS'],
    subject: 'IRG wallet recovery completed',
    urgency: 'high',
  },
  'recovery.cancelled': {
    channels: ['EMAIL', 'WHATSAPP'],
    subject: 'IRG wallet recovery cancelled',
    urgency: 'normal',
  },
  'recovery.rejected': {
    channels: ['EMAIL'],
    subject: 'IRG wallet recovery rejected',
    urgency: 'normal',
  },
  'nominee.registered': {
    channels: ['EMAIL', 'WHATSAPP'],
    subject: 'You have been registered as a nominee on IRG',
    urgency: 'normal',
  },
  'nominee.signature_requested': {
    channels: ['EMAIL', 'WHATSAPP', 'SMS'],
    subject: 'IRG: Your nominee signature is requested',
    urgency: 'high',
  },
  'ownership.transfer_filed': {
    channels: ['EMAIL', 'WHATSAPP'],
    subject: 'IRG: ownership transfer filed',
    urgency: 'high',
  },
  'ownership.transfer_cancelled': {
    channels: ['EMAIL'],
    subject: 'IRG: ownership transfer cancelled',
    urgency: 'normal',
  },
  'ownership.transfer_executed': {
    channels: ['EMAIL', 'WHATSAPP'],
    subject: 'IRG: ownership transfer completed',
    urgency: 'high',
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// SAFETY
// ─────────────────────────────────────────────────────────────────────────────

const FORBIDDEN = [
  'seed_phrase',
  'seed phrase',
  'mnemonic',
  'private_key',
  'private key',
  'wallet_password',
  'wallet password',
  'encrypted_private_key',
];

function safetyCheck(context: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(context || {})) {
    const kl = String(k).toLowerCase();
    if (FORBIDDEN.some((f) => kl.includes(f))) {
      throw new Error(`notification context contains forbidden key: ${k}`);
    }
    if (typeof v === 'string') {
      const vl = v.toLowerCase();
      if (FORBIDDEN.some((f) => vl.includes(f))) {
        throw new Error(`notification context value for ${k} contains forbidden content`);
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TEMPLATES
// ─────────────────────────────────────────────────────────────────────────────

type Template = Partial<Record<Channel, string>>;

const TEMPLATES: Record<string, Template> = {
  'wallet.created': {
    EMAIL:
      'Hello {name},\n\nYour IRG wallet has been created.\n\n' +
      '  Wallet address: {wallet_address}\n  IRG Chain: 888101\n\n' +
      'IMPORTANT: you cannot yet transact with this wallet. Please open the app ' +
      'and complete activation by setting your wallet password and confirming ' +
      'your 15-word seed phrase.\n\n— IRG',
    WHATSAPP:
      'Hello {name}, your IRG wallet has been created. Address: {wallet_address}. ' +
      'Please open the app to activate before you can transact.',
  },
  'wallet.activated': {
    EMAIL:
      'Hello {name},\n\nYour IRG wallet ({wallet_address}) is now active and ready to use.\n\n— IRG',
    WHATSAPP: 'Your IRG wallet is now active and ready to transact.',
  },
  'wallet.unusual_activity': {
    EMAIL:
      'SECURITY ALERT\n\nHello {name},\n\nUnusual activity detected on your IRG wallet ({wallet_address}):\n\n' +
      '  {description}\n\nIf this was you, no action is needed. If not, contact IRG support immediately.\n\n— IRG',
    WHATSAPP: 'IRG security alert: {description}. Contact support if this was not you.',
    SMS: 'IRG alert: {description}. Contact support if not you.',
    PUSH: 'Security alert: {description}',
  },
  'wallet.inactivity_prompt': {
    EMAIL:
      'Hello {name},\n\nWe have not seen any activity on your IRG wallet ({wallet_address}) ' +
      'for {silent_for_days} days. Please open the IRG app and tap "Confirm I am active" ' +
      'to prevent your nominees being alerted unnecessarily.\n\n— IRG',
    WHATSAPP:
      'IRG: your wallet has been silent for a while. Please open the app and tap "Confirm active".',
    PUSH: 'We have not seen you in a year — please confirm you are still active.',
  },
  'wallet.inactivity_reminder': {
    EMAIL:
      'Reminder — IRG wallet activity check\n\nHello {name},\n\n' +
      'Two days ago we asked you to confirm activity on your IRG wallet ({wallet_address}). ' +
      'If we do not hear from you within two more days, your registered nominees will be informed.\n\n— IRG',
    WHATSAPP:
      'IRG REMINDER: please open the app and confirm your wallet is active. Nominees will be alerted in 2 days if silent.',
    SMS: 'IRG: please confirm your wallet is active. Nominees alerted in 2 days.',
    PUSH: 'Second reminder — please confirm wallet activity.',
  },
  'wallet.inactivity_nominee_alert': {
    EMAIL:
      'Hello {nominee_name},\n\nYou are a registered nominee on the IRG wallet at {wallet_address}. ' +
      'It has been silent for over a year despite two notifications. You may wish to contact the holder, ' +
      'or consider initiating a recovery case if circumstances warrant.\n\n— IRG',
    WHATSAPP: 'IRG: a wallet you are nominee on has been silent for over a year. Please check on the holder.',
    SMS: 'IRG: wallet you are nominee on has been silent >1 year. Please check on the holder.',
  },
  'recovery.initiated': {
    EMAIL:
      'URGENT — IRG WALLET RECOVERY INITIATED\n\nHello {name},\n\n' +
      'A recovery case has been filed against your IRG wallet ({wallet_address}).\n\n' +
      '  Path: {path}\n  Filed: {filed_at}\n  Case ID: {case_id}\n' +
      '  Cooling-off ends: {cooling_off_ends_at}\n\n' +
      'IF THIS WAS NOT YOU: Cancel the recovery immediately from the IRG app.\n\n— IRG',
    WHATSAPP: 'URGENT: IRG recovery filed on your wallet. Cancel in-app if this was not you.',
    SMS: 'IRG: recovery case {case_id} filed. Cancel in app if not you.',
    PUSH: 'URGENT: recovery initiated on your wallet',
  },
  'recovery.cancelled': {
    EMAIL: 'IRG recovery case {case_id} has been cancelled. No changes were made.\n\n— IRG',
    WHATSAPP: 'IRG recovery {case_id} cancelled. No changes made.',
  },
  'recovery.executed': {
    EMAIL:
      'Hello {name},\n\nThe recovery on IRG wallet {wallet_address} has been executed.\n\n' +
      '  Case ID: {case_id}\n  Execution tx: {execution_tx_hash}\n' +
      '  Reversibility window ends: {reversibility_ends_at}\n\n— IRG',
    WHATSAPP: 'IRG recovery {case_id} executed. Reversibility window: 90 days.',
    SMS: 'IRG: recovery {case_id} executed.',
  },
  'recovery.rejected': {
    EMAIL:
      'The recovery case {case_id} on IRG wallet {wallet_address} has been rejected.\n\nReason: {reason}\n\n— IRG',
  },
  'nominee.registered': {
    EMAIL:
      'Hello {nominee_name},\n\nYou have been registered as a nominee on the IRG wallet of ' +
      '{nominator_name}. In the event of death, incapacity, or loss of access, you may be called ' +
      'upon to participate in a recovery process.\n\n— IRG',
    WHATSAPP: 'You are now a nominee on {nominator_name}\'s IRG wallet.',
  },
  'nominee.signature_requested': {
    EMAIL:
      'Hello {nominee_name},\n\nYour signature is requested on a recovery case for ' +
      '{nominator_name}\'s IRG wallet. Please open the IRG app to review.\n\nCase ID: {case_id}\n\n— IRG',
    WHATSAPP: 'IRG: signature requested on case {case_id}.',
    SMS: 'IRG: signature requested on recovery case {case_id}.',
  },
  'ownership.transfer_filed': {
    EMAIL:
      'Hello {name},\n\nAn ownership transfer has been filed for your IRG wallet ({wallet_address}).\n\n' +
      '  Case ID: {case_id}\n  Reason: {reason}\n\n' +
      'The Ombudsman will review. Transactions on this wallet are paused until resolution.\n\n— IRG',
    WHATSAPP: 'IRG: ownership transfer case {case_id} filed. Transactions paused.',
  },
  'ownership.transfer_cancelled': {
    EMAIL: 'The ownership transfer case {case_id} has been cancelled. No changes were made.\n\n— IRG',
  },
  'ownership.transfer_executed': {
    EMAIL:
      'Ownership transfer {case_id} has been executed. The new authorised operator has been activated ' +
      'on wallet {wallet_address}. The seed phrase has been rotated.\n\n— IRG',
    WHATSAPP: 'IRG: ownership transfer {case_id} executed.',
  },
};

function render(template: string, context: Record<string, unknown>): string {
  return template.replace(/\{(\w+)\}/g, (_m, k) =>
    context[k] == null ? '' : String(context[k]),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CHANNEL ADAPTERS (stubs — plug in your providers)
// ─────────────────────────────────────────────────────────────────────────────

async function sendEmail(to: string, subject: string, body: string): Promise<boolean> {
  if (!to) return false;
  console.info(`[EMAIL stub] to=${to} subject=${subject} body=${body.slice(0, 200)}`);
  return true;
}
async function sendWhatsApp(to: string, body: string): Promise<boolean> {
  if (!to) return false;
  console.info(`[WHATSAPP stub] to=${to} body=${body.slice(0, 200)}`);
  return true;
}
async function sendSMS(to: string, body: string): Promise<boolean> {
  if (!to) return false;
  console.info(`[SMS stub] to=${to} body=${body.slice(0, 160)}`);
  return true;
}
async function sendPush(participantId: string, body: string): Promise<boolean> {
  if (!participantId) return false;
  console.info(`[PUSH stub] participantId=${participantId} body=${body.slice(0, 200)}`);
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────────────────────

export type Recipient =
  | { participantId: string }
  | { email?: string; mobile?: string; name?: string };

export interface NotifyResult {
  sent: Channel[];
  skipped: string[];
}

async function resolveContact(
  r: Recipient,
): Promise<{ email: string; mobile: string; name: string; participantId: string }> {
  if ('participantId' in r) {
    const p = await prisma.participant.findUnique({
      where: { id: r.participantId },
      include: { contactDetails: true, individualProfile: true },
    });
    const email = p?.contactDetails?.email || '';
    const mobile = p?.contactDetails?.phoneNumber || '';
    const name =
      [p?.individualProfile?.firstName, p?.individualProfile?.lastName]
        .filter(Boolean)
        .join(' ') ||
      p?.username ||
      email.split('@')[0] ||
      '';
    return { email, mobile, name, participantId: r.participantId };
  }
  return {
    email: r.email || '',
    mobile: r.mobile || '',
    name: r.name || '',
    participantId: '',
  };
}

export async function notify(
  recipient: Recipient,
  event: string,
  context: Record<string, unknown> = {},
  overrideChannels?: Channel[],
): Promise<NotifyResult> {
  safetyCheck(context);
  const cfg = EVENTS[event];
  if (!cfg) {
    return { sent: [], skipped: ['unknown_event'] };
  }
  const contact = await resolveContact(recipient);
  const ctx = { name: contact.name, ...context };
  const channels = overrideChannels || cfg.channels;
  const result: NotifyResult = { sent: [], skipped: [] };

  for (const ch of channels) {
    const tpl = TEMPLATES[event]?.[ch];
    if (!tpl) {
      result.skipped.push(`${ch}:no_template`);
      continue;
    }
    const body = render(tpl, ctx);
    let ok = false;
    if (ch === 'EMAIL') ok = await sendEmail(contact.email, cfg.subject, body);
    else if (ch === 'WHATSAPP') ok = await sendWhatsApp(contact.mobile, body);
    else if (ch === 'SMS') ok = await sendSMS(contact.mobile, body);
    else if (ch === 'PUSH') ok = await sendPush(contact.participantId, body);
    (ok ? result.sent : result.skipped).push(ok ? ch : `${ch}:failed`);
  }
  return result;
}
