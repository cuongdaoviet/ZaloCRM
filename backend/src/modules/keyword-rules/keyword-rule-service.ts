/**
 * Keyword rule service — called from the Zalo listener after each inbound
 * message lands. Fire-and-forget; the listener path never blocks on this.
 */
import { randomUUID } from 'node:crypto';
import { prisma } from '../../shared/database/prisma-client.js';
import { logger } from '../../shared/utils/logger.js';
import { matchKeywords, shouldUpgradeStatus } from './keyword-rule-helpers.js';
import { logActivityAsync } from '../activity/activity-service.js';

export interface ProcessInput {
  orgId: string;
  conversationId: string;
  contactId: string | null;
  threadType: 'user' | 'group';
  isSelf: boolean;
  content: string | null;
}

/**
 * Evaluate every enabled rule for the org against the incoming message.
 * For each rule that matches and hasn't already fired on this conversation,
 * apply the rule's actions and write a ledger row.
 *
 * BR-0005/0006: skip group threads and self messages — only inbound
 * 1-1 contact messages can trigger.
 */
export async function processInboundForKeywordRules(opts: ProcessInput): Promise<void> {
  try {
    if (opts.threadType !== 'user') return;
    if (opts.isSelf) return;
    if (!opts.contactId) return;
    if (!opts.content) return;

    const rules = await prisma.keywordRule.findMany({
      where: { orgId: opts.orgId, enabled: true },
    });
    if (rules.length === 0) return;

    for (const rule of rules) {
      const keywords = (rule.keywords as unknown as string[]) ?? [];
      const matched = matchKeywords(opts.content, keywords);
      if (!matched) continue;

      // BR-0003: dedupe per (rule, conversation)
      const existing = await prisma.keywordRuleTrigger.findUnique({
        where: {
          ruleId_conversationId: {
            ruleId: rule.id,
            conversationId: opts.conversationId,
          },
        },
      });
      if (existing) continue;

      await applyRuleToContact(rule, opts.contactId);

      await prisma.keywordRuleTrigger.create({
        data: {
          id: randomUUID(),
          ruleId: rule.id,
          conversationId: opts.conversationId,
          contactId: opts.contactId,
          matchedKeyword: matched,
        },
      });
      logger.info(
        `[keyword-rule] fired ${rule.id} on conversation ${opts.conversationId} (matched: "${matched}")`,
      );
      logActivityAsync({
        orgId: opts.orgId,
        userId: null, // listener fires this, no user action
        action: 'keyword_rule.fired',
        entityType: 'keyword_rule',
        entityId: rule.id,
        details: {
          ruleName: rule.name,
          matchedKeyword: matched,
          conversationId: opts.conversationId,
          contactId: opts.contactId,
        },
      });
    }
  } catch (err) {
    logger.error('[keyword-rule] processInboundForKeywordRules error:', err);
  }
}

async function applyRuleToContact(
  rule: {
    id: string;
    addTag: string | null;
    setStatus: string | null;
    assignToUserId: string | null;
  },
  contactId: string,
): Promise<void> {
  const contact = await prisma.contact.findUnique({
    where: { id: contactId },
    select: { tags: true, status: true, assignedUserId: true },
  });
  if (!contact) return;

  const updates: {
    tags?: string[];
    status?: string;
    assignedUserId?: string;
  } = {};

  if (rule.addTag) {
    const tags = Array.isArray(contact.tags) ? (contact.tags as string[]) : [];
    if (!tags.includes(rule.addTag)) {
      updates.tags = [...tags, rule.addTag];
    }
  }

  if (rule.setStatus && shouldUpgradeStatus(contact.status, rule.setStatus)) {
    updates.status = rule.setStatus;
  }

  if (rule.assignToUserId && !contact.assignedUserId) {
    updates.assignedUserId = rule.assignToUserId;
  }

  if (Object.keys(updates).length === 0) return;

  await prisma.contact.update({
    where: { id: contactId },
    data: updates as any, // tags JSON cast
  });
}
