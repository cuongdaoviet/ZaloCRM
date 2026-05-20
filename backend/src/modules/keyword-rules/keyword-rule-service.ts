/**
 * Keyword rule service — called from the Zalo listener after each inbound
 * message lands. Fire-and-forget; the listener path never blocks on this.
 */
import { randomUUID } from 'node:crypto';
import { prisma } from '../../shared/database/prisma-client.js';
import { logger } from '../../shared/utils/logger.js';
import { matchKeywords, shouldUpgradeStatus } from './keyword-rule-helpers.js';
import { logActivityAsync } from '../activity/activity-service.js';
import { validateTagName } from '../crm-tags/crm-tag-helpers.js';

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

      await applyRuleToContact(
        {
          id: rule.id,
          orgId: rule.orgId,
          addTag: rule.addTag,
          setStatus: rule.setStatus,
          assignToUserId: rule.assignToUserId,
        },
        opts.contactId,
      );

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
    orgId: string;
    addTag: string | null;
    setStatus: string | null;
    assignToUserId: string | null;
  },
  contactId: string,
): Promise<void> {
  const contact = await prisma.contact.findUnique({
    where: { id: contactId },
    select: { status: true, assignedUserId: true, orgId: true },
  });
  if (!contact) return;

  const updates: {
    status?: string;
    assignedUserId?: string;
  } = {};

  // Feature 0019 Phase C: junction table is the only home for tag membership.
  // We upsert a CrmTag row by case-folded name and link via ContactTag —
  // there is no longer a legacy `contact.tags` Json column to mirror.
  let crmTagToAdd: { id: string; name: string } | null = null;
  if (rule.addTag) {
    const validation = validateTagName(rule.addTag);
    if (validation.ok) {
      try {
        const tag = await prisma.crmTag.upsert({
          where: {
            orgId_normalizedName: {
              orgId: contact.orgId,
              normalizedName: validation.normalized,
            },
          },
          create: {
            id: randomUUID(),
            orgId: contact.orgId,
            name: validation.display,
            normalizedName: validation.normalized,
          },
          update: {},
          select: { id: true, name: true },
        });
        crmTagToAdd = tag;
      } catch (err) {
        logger.warn('[keyword-rule] CrmTag upsert failed (non-fatal):', err);
      }
    }
  }

  if (rule.setStatus && shouldUpgradeStatus(contact.status, rule.setStatus)) {
    updates.status = rule.setStatus;
  }

  if (rule.assignToUserId && !contact.assignedUserId) {
    updates.assignedUserId = rule.assignToUserId;
  }

  if (Object.keys(updates).length > 0) {
    await prisma.contact.update({
      where: { id: contactId },
      data: updates,
    });
  }

  // Link CrmTag → Contact and bump usageCount (only if the link is new).
  if (crmTagToAdd) {
    try {
      await prisma.$transaction(async (tx) => {
        const link = await tx.contactTag.findUnique({
          where: { contactId_tagId: { contactId, tagId: crmTagToAdd!.id } },
          select: { contactId: true },
        });
        if (link) return;
        await tx.contactTag.create({
          data: {
            contactId,
            tagId: crmTagToAdd!.id,
            addedByUserId: null, // system action — no caller user
          },
        });
        await tx.crmTag.update({
          where: { id: crmTagToAdd!.id },
          data: { usageCount: { increment: 1 } },
        });
      });
    } catch (err) {
      logger.warn('[keyword-rule] ContactTag link failed (non-fatal):', err);
    }
  }
}
