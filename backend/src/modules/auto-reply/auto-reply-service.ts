/**
 * Auto-reply orchestration — called by the Zalo listener after each incoming
 * message is persisted. Fire-and-forget; no listener path blocks on this.
 *
 * Decision flow (see SPEC §6):
 *   passesStaticGates → cooldown check → recent-staff-activity check → send → ledger insert
 */
import { randomUUID } from 'node:crypto';
import { prisma } from '../../shared/database/prisma-client.js';
import { logger } from '../../shared/utils/logger.js';
import { zaloPool } from '../zalo/zalo-pool.js';
import { zaloRateLimiter } from '../zalo/zalo-rate-limiter.js';
import {
  passesStaticGates,
  substitutePlaceholders,
} from './auto-reply-helpers.js';

interface AutoReplyTriggerInput {
  accountId: string;
  conversationId: string;
  senderUid: string;
  threadType: 'user' | 'group';
  isSelf: boolean;
  /** Used to skip auto-reply when staff replied very recently */
  conversationContactId: string | null;
}

const RECENT_STAFF_REPLY_WINDOW_MS = 5 * 60 * 1000;

export async function maybeAutoReply(input: AutoReplyTriggerInput): Promise<void> {
  try {
    const rule = await prisma.autoReplyRule.findUnique({
      where: { zaloAccountId: input.accountId },
    });
    if (!rule) return; // no rule configured → nothing to do

    if (!passesStaticGates(rule, { threadType: input.threadType, isSelf: input.isSelf }, new Date())) {
      return;
    }

    // BR-0003: cooldown per (rule, contact)
    if (input.senderUid) {
      const history = await prisma.autoReplyHistory.findUnique({
        where: { ruleId_contactUid: { ruleId: rule.id, contactUid: input.senderUid } },
      });
      if (history) {
        const ageMin = (Date.now() - history.sentAt.getTime()) / 60000;
        if (ageMin < rule.cooldownMinutes) {
          logger.debug(
            `[auto-reply] cooldown active for ${input.senderUid} (${ageMin.toFixed(1)}/${rule.cooldownMinutes}min)`,
          );
          return;
        }
      }
    }

    // BR-0007: skip if staff replied very recently in this conversation
    const recentStaffReply = await prisma.message.findFirst({
      where: {
        conversationId: input.conversationId,
        senderType: 'self',
        repliedByUserId: { not: null },
        sentAt: { gte: new Date(Date.now() - RECENT_STAFF_REPLY_WINDOW_MS) },
      },
      select: { id: true },
    });
    if (recentStaffReply) {
      logger.debug(
        `[auto-reply] staff replied within ${RECENT_STAFF_REPLY_WINDOW_MS / 60000}min, skipping`,
      );
      return;
    }

    // BR-0006: respect the rate limiter — skip silently if hit
    const limits = zaloRateLimiter.checkLimits(input.accountId);
    if (!limits.allowed) {
      logger.warn(`[auto-reply] rate-limit hit on account ${input.accountId}, skipping`);
      return;
    }

    // Send through the live zca-js instance
    const instance = zaloPool.getInstance(input.accountId);
    if (!instance?.api) {
      logger.warn(`[auto-reply] account ${input.accountId} not connected, skipping`);
      return;
    }

    const account = await prisma.zaloAccount.findUnique({
      where: { id: input.accountId },
      select: { zaloUid: true },
    });
    const contact = input.conversationContactId
      ? await prisma.contact.findUnique({
          where: { id: input.conversationContactId },
          select: { fullName: true },
        })
      : null;

    const finalMessage = substitutePlaceholders(rule.message, contact);

    zaloRateLimiter.recordSend(input.accountId);
    await instance.api.sendMessage({ msg: finalMessage }, input.senderUid, 0);

    // Persist the outgoing message so it shows up in the thread alongside
    // organic replies. zaloMsgId is unknown for auto-reply (zca-js doesn't
    // return the new msgId reliably for sendMessage(text)), so leave it null.
    const sentAt = new Date();
    await prisma.message.create({
      data: {
        id: randomUUID(),
        conversationId: input.conversationId,
        senderType: 'self',
        senderUid: account?.zaloUid ?? '',
        senderName: 'Auto-reply',
        content: finalMessage,
        contentType: 'text',
        sentAt,
      },
    });
    await prisma.conversation.update({
      where: { id: input.conversationId },
      data: { lastMessageAt: sentAt, isReplied: true, unreadCount: 0 },
    });

    // Upsert the cooldown ledger
    await prisma.autoReplyHistory.upsert({
      where: { ruleId_contactUid: { ruleId: rule.id, contactUid: input.senderUid } },
      create: { id: randomUUID(), ruleId: rule.id, contactUid: input.senderUid, sentAt },
      update: { sentAt },
    });
    await prisma.autoReplyRule.update({
      where: { id: rule.id },
      data: { lastTriggeredAt: sentAt },
    });

    logger.info(
      `[auto-reply] sent to ${input.senderUid} via account ${input.accountId}`,
    );
  } catch (err) {
    logger.error('[auto-reply] maybeAutoReply error:', err);
  }
}
