/**
 * Phase A.1 — Pull a Zalo account's native label catalog into our DB.
 *
 * Mapping:
 *   zca-js LabelData                  →  Our DB
 *   -----------------                    -----------------------------------
 *   id (number)                       →  ZaloLabel.zaloLabelId (string)
 *   text, textKey                     →  ZaloLabel.text, .textKey
 *   color, emoji, offset, createTime  →  ZaloLabel.{color,emoji,offset,createTime}
 *   conversations (string[])          →  ZaloLabel.conversations (Json)
 *   version (top-level)               →  ZaloLabel.version on each row
 *
 * Per group: one `CrmTagGroup(managedBy='zalo_sync', zaloAccountId)` per Zalo
 * account. Per label: one `CrmTag(managedBy='zalo_sync', sourceZaloLabelId,
 * groupId)` linked to that group.
 *
 * Re-sync semantics (BR-0009):
 *  - Upsert by (zaloAccountId, zaloLabelId).
 *  - CrmTag matched via sourceZaloLabelId. If a tag exists with the same
 *    normalizedName as a Zalo label but no sourceZaloLabelId yet, we ADOPT it
 *    (set managedBy='zalo_sync' + sourceZaloLabelId). Warning per adoption.
 *  - Any CrmTag with managedBy='zalo_sync' whose sourceZaloLabelId is not in
 *    the new payload → archive (set archivedAt = now). Existing ContactTag
 *    links are kept (BR-0011 — archive does not delete the link).
 */
import { prisma } from '../../shared/database/prisma-client.js';
import { logger } from '../../shared/utils/logger.js';
import { normalizeName } from './crm-tag-helpers.js';

export interface ZaloLabelDataInput {
  id: number;
  text: string;
  textKey: string;
  conversations: string[];
  color: string;
  offset: number;
  emoji: string;
  createTime: number;
}

export interface SyncResult {
  groupId: string;
  labelsCreated: number;
  labelsUpdated: number;
  labelsArchived: number;
  adopted: number;
}

export async function syncZaloLabels(opts: {
  orgId: string;
  zaloAccountId: string;
  labels: ZaloLabelDataInput[];
  version: number;
  zaloAccountDisplayName: string | null;
}): Promise<SyncResult> {
  const { orgId, zaloAccountId, labels, version, zaloAccountDisplayName } = opts;

  // 1. Ensure a CrmTagGroup exists for this Zalo account.
  const groupName = zaloAccountDisplayName
    ? `Zalo — ${zaloAccountDisplayName}`
    : `Zalo account ${zaloAccountId.slice(0, 8)}`;

  const group = await prisma.crmTagGroup.upsert({
    where: { orgId_name: { orgId, name: groupName } },
    create: {
      orgId,
      name: groupName,
      managedBy: 'zalo_sync',
      zaloAccountId,
    },
    update: {
      managedBy: 'zalo_sync',
      zaloAccountId,
      archivedAt: null,
    },
  });

  // 2. Upsert each label row + corresponding CrmTag.
  let labelsCreated = 0;
  let labelsUpdated = 0;
  let adopted = 0;
  const seenLabelIds = new Set<string>();

  for (const ld of labels) {
    const zaloLabelId = String(ld.id);
    seenLabelIds.add(zaloLabelId);

    // Upsert ZaloLabel row (mirror of Zalo's catalog).
    await prisma.zaloLabel.upsert({
      where: { zaloAccountId_zaloLabelId: { zaloAccountId, zaloLabelId } },
      create: {
        orgId,
        zaloAccountId,
        zaloLabelId,
        textKey: ld.textKey,
        text: ld.text,
        color: ld.color,
        emoji: ld.emoji || null,
        offset: ld.offset,
        version,
        conversations: ld.conversations,
        createTime: BigInt(ld.createTime || 0),
      },
      update: {
        textKey: ld.textKey,
        text: ld.text,
        color: ld.color,
        emoji: ld.emoji || null,
        offset: ld.offset,
        version,
        conversations: ld.conversations,
      },
    });

    // Look up an existing CrmTag — first by sourceZaloLabelId, then by name
    // collision (for adoption).
    const existing = await prisma.crmTag.findFirst({
      where: {
        orgId,
        OR: [
          { sourceZaloLabelId: zaloLabelId },
          { normalizedName: normalizeName(ld.text), managedBy: null },
        ],
      },
    });

    if (existing) {
      const wasAdoption =
        !existing.sourceZaloLabelId && existing.managedBy !== 'zalo_sync';
      if (wasAdoption) {
        logger.warn(
          `[zalo-label-sync] adopted CrmTag "${existing.name}" (id=${existing.id}) ` +
            `into Zalo-managed via label id=${zaloLabelId}`,
        );
        adopted++;
      }
      await prisma.crmTag.update({
        where: { id: existing.id },
        data: {
          name: ld.text,
          normalizedName: normalizeName(ld.text),
          color: ld.color,
          emoji: ld.emoji || null,
          managedBy: 'zalo_sync',
          sourceZaloLabelId: zaloLabelId,
          groupId: group.id,
          archivedAt: null,
        },
      });
      labelsUpdated++;
    } else {
      await prisma.crmTag.create({
        data: {
          orgId,
          name: ld.text,
          normalizedName: normalizeName(ld.text),
          color: ld.color,
          emoji: ld.emoji || null,
          managedBy: 'zalo_sync',
          sourceZaloLabelId: zaloLabelId,
          groupId: group.id,
        },
      });
      labelsCreated++;
    }
  }

  // 3. Archive any Zalo-managed CrmTag in this group whose source label is
  // no longer in the catalog. Existing ContactTag links are preserved
  // (BR-0011: archive ≠ delete).
  const orphaned = await prisma.crmTag.findMany({
    where: {
      orgId,
      managedBy: 'zalo_sync',
      groupId: group.id,
      archivedAt: null,
      sourceZaloLabelId: { notIn: Array.from(seenLabelIds) },
    },
    select: { id: true },
  });
  if (orphaned.length > 0) {
    await prisma.crmTag.updateMany({
      where: { id: { in: orphaned.map((t) => t.id) } },
      data: { archivedAt: new Date(), isActive: false },
    });
  }

  // Also drop the ZaloLabel rows that were removed upstream so the local
  // mirror matches Zalo's truth.
  await prisma.zaloLabel.deleteMany({
    where: {
      zaloAccountId,
      zaloLabelId: { notIn: Array.from(seenLabelIds) },
    },
  });

  return {
    groupId: group.id,
    labelsCreated,
    labelsUpdated,
    labelsArchived: orphaned.length,
    adopted,
  };
}
