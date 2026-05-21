/**
 * Duplicate contact scan + merge service (feature 0018).
 *
 * `scanDuplicates`  - pulls non-merged contacts, runs detection, upserts
 *                     DuplicateGroup rows keyed by hash(sorted contact ids).
 *                     Idempotent: same population on rescan does not insert a
 *                     duplicate row, and groups already dismissed are skipped.
 *
 * `mergeContacts`   - wraps every FK rewrite in a single Prisma $transaction,
 *                     guards against concurrent merges via WHERE status=pending,
 *                     handles CampaignTarget + Conversation unique-constraint
 *                     conflicts BEFORE the bulk updates so the txn never aborts
 *                     mid-flight. Emits one `contact.merged` activity per
 *                     merged secondary AFTER the txn commits.
 *
 * `dismissGroup`    - marks a pending group dismissed so future scans skip it.
 *
 * Decisions baked in (from SPEC §Decisions):
 * - D-0002: no undo. Merge is one-way; we keep `mergedIntoId` for audit.
 * - D-0003: cross-conversation merge keeps both threads pointing at primary
 *           except when two threads share `(zaloAccountId, externalThreadId)`
 *           (EC-0006) — then we move messages/notes to the primary thread and
 *           delete the duplicate.
 */
import { createHash } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../../shared/database/prisma-client.js';
import { logger } from '../../shared/utils/logger.js';
import { logActivityAsync } from '../activity/activity-service.js';
import {
  detectAll,
  type ContactRow,
  type DetectedGroup,
  type DuplicateLevel,
} from './duplicate-detection.js';

type Tx = Prisma.TransactionClient | PrismaClient;

export const ALL_LEVELS: DuplicateLevel[] = [
  'phone_exact',
  'zaloUid_exact',
  // Feature 0034 — register the new strategy in the default level set so
  // scan-duplicates picks it up without an explicit `levels` arg.
  'globalId_exact',
  'name_fuzzy',
];

export interface ScanResult {
  status: 'completed';
  groupsCreated: number;
  groupsExisting: number;
  contactsScanned: number;
  durationMs: number;
  nameSkipped: boolean;
}

// Allowed fieldsToKeep keys (BR-0008 + § POST /merge body).
const FIELD_OVERRIDE_KEYS = [
  'fullName',
  'phone',
  'email',
  'source',
  'assignedUserId',
] as const;
type FieldOverrideKey = (typeof FIELD_OVERRIDE_KEYS)[number];

export interface MergeResult {
  status: 'merged';
  primaryContactId: string;
  mergedContactIds: string[];
  moved: {
    conversations: number;
    orders: number;
    appointments: number;
    notes: number;
    campaignTargets: number;
    skippedDuplicateTargets: number;
    mergedConversations: number;
  };
}

function hashIds(sorted: string[]): string {
  return createHash('sha1').update(sorted.join('|')).digest('hex');
}

// ────────────────────────────────────────────────────────────────────────────
// Scan
// ────────────────────────────────────────────────────────────────────────────

export async function scanDuplicates(
  orgId: string,
  levels: DuplicateLevel[] = ALL_LEVELS,
): Promise<ScanResult> {
  const startedAt = Date.now();

  // Only consider live contacts (not previously merged).
  const contacts = await prisma.contact.findMany({
    where: { orgId, mergedIntoId: null },
    // Feature 0034 — pull `zaloGlobalId` so the globalId_exact detector can
    // bucket on it. Always-selected; cost is one extra column per row.
    select: {
      id: true,
      fullName: true,
      phone: true,
      zaloUid: true,
      zaloGlobalId: true,
    },
  });

  const rows: ContactRow[] = contacts;
  const { groups, nameSkipped } = detectAll(rows, levels);

  // Existing groups for this org keyed by contactIdsHash to dedupe.
  const existing = await prisma.duplicateGroup.findMany({
    where: { orgId },
    select: { contactIdsHash: true, status: true },
  });
  const existingByHash = new Map<string, string>();
  for (const e of existing) existingByHash.set(e.contactIdsHash, e.status);

  let groupsCreated = 0;
  let groupsExisting = 0;

  // Insert serially — counts are small (typically < 100) and we want clean
  // error isolation per group.
  for (const g of groups) {
    const hash = hashIds(g.contactIds);
    const seenStatus = existingByHash.get(hash);
    if (seenStatus === 'pending' || seenStatus === 'dismissed' || seenStatus === 'merged') {
      groupsExisting++;
      continue;
    }
    try {
      await prisma.duplicateGroup.create({
        data: {
          orgId,
          level: g.level,
          confidence: g.confidence,
          contactIds: g.contactIds,
          contactIdsHash: hash,
          status: 'pending',
        },
      });
      groupsCreated++;
    } catch (err) {
      // Race with a concurrent scan — unique violation on (orgId, contactIdsHash)
      logger.warn(`[duplicate-scan] insert race for hash ${hash}:`, err);
      groupsExisting++;
    }
  }

  return {
    status: 'completed',
    groupsCreated,
    groupsExisting,
    contactsScanned: contacts.length,
    durationMs: Date.now() - startedAt,
    nameSkipped,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Dismiss
// ────────────────────────────────────────────────────────────────────────────

export interface DismissResult {
  status: 'dismissed';
  resolvedAt: Date;
}

export async function dismissGroup(
  orgId: string,
  groupId: string,
  userId: string,
  _reason?: string,
): Promise<DismissResult | { error: 'not_found' | 'already_resolved' }> {
  const group = await prisma.duplicateGroup.findFirst({
    where: { id: groupId, orgId },
    select: { id: true, status: true },
  });
  if (!group) return { error: 'not_found' };
  if (group.status !== 'pending') return { error: 'already_resolved' };

  const resolvedAt = new Date();
  // Use conditional update for concurrency safety
  const updated = await prisma.duplicateGroup.updateMany({
    where: { id: groupId, orgId, status: 'pending' },
    data: { status: 'dismissed', resolvedByUserId: userId, resolvedAt },
  });
  if (updated.count === 0) return { error: 'already_resolved' };
  return { status: 'dismissed', resolvedAt };
}

// ────────────────────────────────────────────────────────────────────────────
// Merge
// ────────────────────────────────────────────────────────────────────────────

export type MergeInput = {
  fieldsToKeep?: Partial<Record<FieldOverrideKey, string>>;
};

export type MergeError =
  | { error: 'not_found' }
  | { error: 'bad_request'; message: string }
  | { error: 'conflict' };

/** Internal helper: validate `fieldsToKeep` shape + that every value is an id in the group. */
function validateFieldsToKeep(
  fieldsToKeep: MergeInput['fieldsToKeep'] | undefined,
  groupContactIds: Set<string>,
): { ok: true; clean: Partial<Record<FieldOverrideKey, string>> } | { ok: false; message: string } {
  if (!fieldsToKeep) return { ok: true, clean: {} };
  const clean: Partial<Record<FieldOverrideKey, string>> = {};
  for (const k of Object.keys(fieldsToKeep) as FieldOverrideKey[]) {
    if (!FIELD_OVERRIDE_KEYS.includes(k)) {
      return { ok: false, message: `fieldsToKeep chứa key không hợp lệ: ${k}` };
    }
    const v = fieldsToKeep[k];
    if (typeof v !== 'string' || !v) {
      return { ok: false, message: `fieldsToKeep.${k} phải là contact id` };
    }
    if (!groupContactIds.has(v)) {
      return {
        ok: false,
        message: `fieldsToKeep.${k} (${v}) không thuộc group`,
      };
    }
    clean[k] = v;
  }
  return { ok: true, clean };
}

export async function mergeContacts(
  orgId: string,
  groupId: string,
  primaryContactId: string,
  input: MergeInput,
  userId: string,
): Promise<MergeResult | MergeError> {
  // 1) Read the group (no lock yet — we lock via the conditional update below).
  const group = await prisma.duplicateGroup.findFirst({
    where: { id: groupId, orgId },
    select: {
      id: true,
      status: true,
      contactIds: true,
      level: true,
    },
  });
  if (!group) return { error: 'not_found' };
  if (group.status !== 'pending') {
    return { error: 'bad_request', message: 'Nhóm trùng đã được xử lý' };
  }

  const groupContactIds = new Set<string>((group.contactIds as string[]) ?? []);
  if (!groupContactIds.has(primaryContactId)) {
    return {
      error: 'bad_request',
      message: 'primaryContactId không thuộc group',
    };
  }
  const validated = validateFieldsToKeep(input.fieldsToKeep, groupContactIds);
  if (!validated.ok) {
    return { error: 'bad_request', message: validated.message };
  }

  // 2) Run the merge inside a transaction. On the first write we conditionally
  // update the group row — if status changed (another admin won the race), the
  // updateMany returns count=0 and we throw to roll back.
  let mergedSecondaryIds: string[] = [];
  let moved = {
    conversations: 0,
    orders: 0,
    appointments: 0,
    notes: 0,
    campaignTargets: 0,
    skippedDuplicateTargets: 0,
    mergedConversations: 0,
  };

  try {
    await prisma.$transaction(async (tx: Tx) => {
      // 2a) Concurrency guard: only first caller flips status away from pending.
      const lockUpdate = await tx.duplicateGroup.updateMany({
        where: { id: groupId, orgId, status: 'pending' },
        data: { status: 'pending' }, // no-op write — just to assert state under txn
      });
      if (lockUpdate.count === 0) {
        // Another admin already moved the group out of pending
        throw new ConflictError();
      }

      // 2b) Re-fetch contacts inside the txn for primary validation + payload build.
      const contacts = await tx.contact.findMany({
        where: { orgId, id: { in: Array.from(groupContactIds) } },
        select: {
          id: true,
          fullName: true,
          phone: true,
          email: true,
          source: true,
          assignedUserId: true,
          notes: true,
          metadata: true,
          mergedIntoId: true,
          // Feature 0034 BR-0005 — required so we can carry the canonical
          // globalId onto the primary when it was previously NULL.
          zaloGlobalId: true,
        },
      });
      const byId = new Map(contacts.map((c) => [c.id, c]));
      const primary = byId.get(primaryContactId);
      if (!primary) {
        throw new BadRequestError('Primary contact không thuộc org');
      }
      if (primary.mergedIntoId) {
        throw new BadRequestError('Primary đã được gộp vào contact khác');
      }
      const secondaries = contacts.filter(
        (c) => c.id !== primaryContactId && !c.mergedIntoId,
      );
      if (secondaries.length === 0) {
        // Nothing to merge — group is stale (all secondaries already merged).
        throw new BadRequestError('Group đã không còn contact phụ để gộp');
      }

      // 2c) Compute the new primary field values.
      // Start with primary as-is, then apply fieldsToKeep overrides, then
      // shallow-merge metadata + union tags + concat notes (BR-0008).
      const primaryUpdate: Prisma.ContactUpdateInput = {};

      for (const k of FIELD_OVERRIDE_KEYS) {
        const fromId = validated.clean[k];
        if (!fromId || fromId === primaryContactId) continue;
        const sourceContact = byId.get(fromId);
        if (!sourceContact) continue;
        const value = sourceContact[k as keyof typeof sourceContact] as
          | string
          | null
          | undefined;
        if (k === 'assignedUserId') {
          (primaryUpdate as Record<string, unknown>).assignedUserId =
            value ?? null;
        } else {
          (primaryUpdate as Record<string, unknown>)[k] = value ?? null;
        }
      }

      // notes concat
      let mergedNotes = primary.notes ?? '';
      for (const s of secondaries) {
        if (s.notes && s.notes.trim()) {
          mergedNotes =
            (mergedNotes ? mergedNotes + '\n\n' : '') +
            `--- Gộp từ ${s.fullName ?? '(không tên)'} ---\n${s.notes}`;
        }
      }

      // metadata shallow merge — primary wins on key conflict
      let mergedMetadata: Record<string, unknown> = {};
      for (const s of secondaries) {
        const sMeta = (s.metadata ?? {}) as Record<string, unknown>;
        mergedMetadata = { ...mergedMetadata, ...sMeta };
      }
      const primaryMeta = (primary.metadata ?? {}) as Record<string, unknown>;
      mergedMetadata = { ...mergedMetadata, ...primaryMeta };

      (primaryUpdate as Record<string, unknown>).notes = mergedNotes || null;
      (primaryUpdate as Record<string, unknown>).metadata = mergedMetadata;

      // Feature 0034 BR-0005 — carry the canonical Zalo `globalId` onto the
      // primary if the primary itself is missing one but a secondary has it.
      // Conflicting non-null values: KEEP primary's, log warning so ops can
      // inspect. We do NOT expose this as a fieldsToKeep override on purpose —
      // it's a derived identity, not a user-facing field.
      if (primary.zaloGlobalId == null) {
        const carrier = secondaries.find((s) => s.zaloGlobalId != null);
        if (carrier?.zaloGlobalId) {
          (primaryUpdate as Record<string, unknown>).zaloGlobalId =
            carrier.zaloGlobalId;
        }
      } else {
        for (const s of secondaries) {
          if (
            s.zaloGlobalId &&
            s.zaloGlobalId !== primary.zaloGlobalId
          ) {
            logger.warn(
              `[duplicate-merge] globalId conflict on merge — primary=${primary.id} ` +
                `keptGlobalId=${primary.zaloGlobalId} secondary=${s.id} ` +
                `discardedGlobalId=${s.zaloGlobalId} groupId=${groupId}`,
            );
          }
        }
      }

      const secondaryIds = secondaries.map((s) => s.id);

      // Feature 0019 Phase C: union the ContactTag junction rows (BR-0008).
      // Pull the distinct tagIds across the secondaries that aren't already on
      // the primary, then insert ContactTag rows for the primary. usageCount
      // doesn't change because the same tag now points at the primary instead
      // of N secondaries; we bump it by 1 per net-new link and decrement once
      // per secondary link removed below.
      const secondaryLinks = await tx.contactTag.findMany({
        where: { contactId: { in: secondaryIds } },
        select: { tagId: true },
      });
      const primaryLinks = await tx.contactTag.findMany({
        where: { contactId: primaryContactId },
        select: { tagId: true },
      });
      const primaryTagIdSet = new Set(primaryLinks.map((l) => l.tagId));
      const tagsToAddToPrimary = Array.from(
        new Set(
          secondaryLinks
            .map((l) => l.tagId)
            .filter((id) => !primaryTagIdSet.has(id)),
        ),
      );
      if (tagsToAddToPrimary.length > 0) {
        await tx.contactTag.createMany({
          data: tagsToAddToPrimary.map((tagId) => ({
            contactId: primaryContactId,
            tagId,
          })),
          skipDuplicates: true,
        });
        // Newly attached to the primary — bump usageCount by 1 per tag.
        await tx.crmTag.updateMany({
          where: { id: { in: tagsToAddToPrimary }, orgId },
          data: { usageCount: { increment: 1 } },
        });
      }

      // Drop the secondaries' ContactTag rows so the primary is the only
      // contact carrying each tag (secondaries become merged tombstones —
      // their chips would otherwise still show in admin tooling). Decrement
      // usageCount once per removed link.
      const secondaryLinkRemoval = await tx.contactTag.deleteMany({
        where: { contactId: { in: secondaryIds } },
      });
      if (secondaryLinkRemoval.count > 0) {
        // Group decrements per tagId so we decrement by the actual link
        // count, not just once.
        const decrementByTagId = new Map<string, number>();
        for (const l of secondaryLinks) {
          decrementByTagId.set(l.tagId, (decrementByTagId.get(l.tagId) ?? 0) + 1);
        }
        for (const [tagId, count] of decrementByTagId) {
          await tx.crmTag.update({
            where: { id: tagId },
            data: { usageCount: { decrement: count } },
          });
        }
      }

      // 2d) EC-0005 — pre-resolve CampaignTarget unique conflicts.
      // For every (campaignId) that has BOTH primary + a secondary as targets,
      // delete the secondary's row. Then re-point the remaining secondaries.
      const allTargets = await tx.campaignTarget.findMany({
        where: { contactId: { in: [primaryContactId, ...secondaryIds] } },
        select: { id: true, campaignId: true, contactId: true },
      });
      const primaryCampaignIds = new Set(
        allTargets.filter((t) => t.contactId === primaryContactId).map((t) => t.campaignId),
      );
      const targetsToDelete: string[] = [];
      const targetsToRetarget: string[] = [];
      for (const t of allTargets) {
        if (t.contactId === primaryContactId) continue;
        if (primaryCampaignIds.has(t.campaignId)) targetsToDelete.push(t.id);
        else targetsToRetarget.push(t.id);
      }
      if (targetsToDelete.length > 0) {
        await tx.campaignTarget.deleteMany({ where: { id: { in: targetsToDelete } } });
        moved.skippedDuplicateTargets = targetsToDelete.length;
      }
      if (targetsToRetarget.length > 0) {
        const r = await tx.campaignTarget.updateMany({
          where: { id: { in: targetsToRetarget } },
          data: { contactId: primaryContactId },
        });
        moved.campaignTargets = r.count;
      }

      // 2e) EC-0006 — pre-resolve Conversation unique conflicts.
      // For every (zaloAccountId, externalThreadId) shared between primary and
      // a secondary, move messages+notes onto the primary's conversation and
      // delete the secondary's conversation.
      const allConvs = await tx.conversation.findMany({
        where: {
          orgId,
          contactId: { in: [primaryContactId, ...secondaryIds] },
        },
        select: {
          id: true,
          contactId: true,
          zaloAccountId: true,
          externalThreadId: true,
        },
      });
      const primaryConvKey = new Map<string, string>();
      for (const c of allConvs) {
        if (c.contactId === primaryContactId && c.externalThreadId != null) {
          primaryConvKey.set(`${c.zaloAccountId}::${c.externalThreadId}`, c.id);
        }
      }
      const convsToDelete: string[] = [];
      for (const c of allConvs) {
        if (c.contactId === primaryContactId) continue;
        if (c.externalThreadId == null) continue;
        const k = `${c.zaloAccountId}::${c.externalThreadId}`;
        const primaryConvId = primaryConvKey.get(k);
        if (primaryConvId && primaryConvId !== c.id) {
          // Move messages + notes from the secondary conv → primary conv
          await tx.message.updateMany({
            where: { conversationId: c.id },
            data: { conversationId: primaryConvId },
          });
          await tx.conversationNote.updateMany({
            where: { conversationId: c.id },
            data: { conversationId: primaryConvId },
          });
          // Re-point orders that referenced the secondary conv
          await tx.order.updateMany({
            where: { conversationId: c.id },
            data: { conversationId: primaryConvId },
          });
          convsToDelete.push(c.id);
        }
      }
      if (convsToDelete.length > 0) {
        await tx.conversation.deleteMany({ where: { id: { in: convsToDelete } } });
        moved.mergedConversations = convsToDelete.length;
      }

      // 2f) Re-point the remaining FK rows from secondaries → primary.
      const convResult = await tx.conversation.updateMany({
        where: { orgId, contactId: { in: secondaryIds } },
        data: { contactId: primaryContactId },
      });
      moved.conversations = convResult.count;

      const orderResult = await tx.order.updateMany({
        where: { orgId, contactId: { in: secondaryIds } },
        data: { contactId: primaryContactId },
      });
      moved.orders = orderResult.count;

      const apptResult = await tx.appointment.updateMany({
        where: { orgId, contactId: { in: secondaryIds } },
        data: { contactId: primaryContactId },
      });
      moved.appointments = apptResult.count;

      // Notes count for the response — notes belong to conversations that we
      // just re-pointed, so count them after the conversation move.
      const notesCount = await tx.conversationNote.count({
        where: { conversation: { contactId: primaryContactId, orgId } },
      });
      moved.notes = notesCount;

      // 2g) Mark secondaries as merged.
      const mergedAt = new Date();
      await tx.contact.updateMany({
        where: { id: { in: secondaryIds } },
        data: {
          mergedIntoId: primaryContactId,
          mergedAt,
          status: 'merged',
        },
      });

      // 2h) Apply the consolidated primary update.
      await tx.contact.update({
        where: { id: primaryContactId },
        data: primaryUpdate,
      });

      // 2i) Finalize the group row.
      await tx.duplicateGroup.update({
        where: { id: groupId },
        data: {
          status: 'merged',
          primaryContactId,
          resolvedByUserId: userId,
          resolvedAt: mergedAt,
        },
      });

      mergedSecondaryIds = secondaryIds;
    });
  } catch (err) {
    if (err instanceof ConflictError) return { error: 'conflict' };
    if (err instanceof BadRequestError) {
      return { error: 'bad_request', message: err.message };
    }
    logger.error('[duplicate-merge] transaction failed:', err);
    throw err;
  }

  // 3) After commit — fire activity logs (one per secondary). BR-0010.
  for (const secondaryId of mergedSecondaryIds) {
    logActivityAsync({
      orgId,
      userId,
      action: 'contact.merged',
      entityType: 'contact',
      entityId: secondaryId,
      details: {
        mergedInto: primaryContactId,
        groupId,
        level: group.level,
      },
    });
  }

  return {
    status: 'merged',
    primaryContactId,
    mergedContactIds: mergedSecondaryIds,
    moved,
  };
}

// ── Internal error markers (used only to short-circuit the transaction) ─────
class ConflictError extends Error {
  constructor() {
    super('conflict');
    this.name = 'ConflictError';
  }
}
class BadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BadRequestError';
  }
}
