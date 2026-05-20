/**
 * CRM tags service — feature 0019.
 *
 * Owns the business logic for the `CrmTag` / `CrmTagGroup` / `ContactTag`
 * tables. The route layer is a thin wrapper around these functions.
 *
 * Phase C: the legacy `contact.tags` Json column has been dropped. The
 * `ContactTag` junction is the single source of truth for tag membership.
 */
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../../shared/database/prisma-client.js';
import { normalizeName, validateColor, validateTagName } from './crm-tag-helpers.js';

export const DEFAULT_TAG_COLOR = '#9E9E9E';

export interface CreateTagInput {
  name: string;
  color?: string;
  emoji?: string | null;
  description?: string | null;
  groupId?: string | null;
}

export interface UpdateTagInput {
  name?: string;
  color?: string;
  emoji?: string | null;
  description?: string | null;
  groupId?: string | null;
  order?: number;
  archivedAt?: Date | null;
}

export type ServiceError =
  | { code: 'INVALID_NAME'; message: string }
  | { code: 'INVALID_COLOR'; message: string }
  | { code: 'INVALID_GROUP'; message: string }
  | { code: 'INVALID_TAG_ID'; message: string }
  | { code: 'TAG_ARCHIVED'; message: string }
  | { code: 'TAG_DUPLICATE'; message: string; existingTagId: string }
  | { code: 'ZALO_MANAGED'; message: string }
  | { code: 'NOT_FOUND'; message: string };

export type ServiceResult<T> = { ok: true; value: T } | { ok: false; error: ServiceError };

export interface ListTagsFilters {
  groupId?: string;
  /** `'crm'` filters `managedBy IS NULL`; `'zalo_sync'` filters that label literally. */
  managedBy?: 'crm' | 'zalo_sync';
  includeArchived?: boolean;
  search?: string;
}

// ── Read ─────────────────────────────────────────────────────────────────────

export async function listTags(orgId: string, filters: ListTagsFilters = {}) {
  const where: Prisma.CrmTagWhereInput = { orgId };

  if (filters.groupId) where.groupId = filters.groupId;
  if (filters.managedBy === 'crm') where.managedBy = null;
  if (filters.managedBy === 'zalo_sync') where.managedBy = 'zalo_sync';
  if (!filters.includeArchived) where.archivedAt = null;
  if (filters.search && filters.search.trim().length > 0) {
    where.name = { contains: filters.search.trim(), mode: 'insensitive' };
  }

  return prisma.crmTag.findMany({
    where,
    orderBy: [{ order: 'asc' }, { name: 'asc' }],
    include: { group: { select: { id: true, name: true } } },
  });
}

export async function listTagGroups(orgId: string, includeArchived = false) {
  const where: Prisma.CrmTagGroupWhereInput = { orgId };
  if (!includeArchived) where.archivedAt = null;
  return prisma.crmTagGroup.findMany({
    where,
    orderBy: [{ order: 'asc' }, { name: 'asc' }],
  });
}

// ── Create ───────────────────────────────────────────────────────────────────

export async function createTag(
  orgId: string,
  input: CreateTagInput,
): Promise<ServiceResult<Awaited<ReturnType<typeof prisma.crmTag.create>>>> {
  const nameCheck = validateTagName(input.name);
  if (!nameCheck.ok) return { ok: false, error: { code: 'INVALID_NAME', message: nameCheck.error } };

  const color = input.color ?? DEFAULT_TAG_COLOR;
  if (!validateColor(color)) {
    return { ok: false, error: { code: 'INVALID_COLOR', message: 'Màu phải có dạng #RRGGBB' } };
  }

  if (input.groupId) {
    const group = await prisma.crmTagGroup.findFirst({
      where: { id: input.groupId, orgId },
      select: { id: true },
    });
    if (!group) {
      return { ok: false, error: { code: 'INVALID_GROUP', message: 'Group không hợp lệ' } };
    }
  }

  try {
    const created = await prisma.crmTag.create({
      data: {
        id: randomUUID(),
        orgId,
        name: nameCheck.display,
        normalizedName: nameCheck.normalized,
        color,
        emoji: input.emoji ?? null,
        description: input.description ?? null,
        groupId: input.groupId ?? null,
      },
    });
    return { ok: true, value: created };
  } catch (err) {
    // P2002 = unique constraint violation. Hand back the existing tag's id
    // so the FE can offer "use existing instead" UX.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const existing = await prisma.crmTag.findUnique({
        where: { orgId_normalizedName: { orgId, normalizedName: nameCheck.normalized } },
        select: { id: true },
      });
      return {
        ok: false,
        error: {
          code: 'TAG_DUPLICATE',
          message: 'Nhãn đã tồn tại (so khớp không phân biệt hoa thường)',
          existingTagId: existing?.id ?? '',
        },
      };
    }
    throw err;
  }
}

// ── Update ───────────────────────────────────────────────────────────────────

/**
 * Patch a tag. Zalo-sync tags only allow `order` and `groupId` mutations —
 * any attempt to change name / color / emoji / description / archivedAt
 * returns `ZALO_MANAGED`.
 */
export async function updateTag(
  orgId: string,
  id: string,
  patch: UpdateTagInput,
): Promise<ServiceResult<Awaited<ReturnType<typeof prisma.crmTag.update>>>> {
  const existing = await prisma.crmTag.findFirst({ where: { id, orgId } });
  if (!existing) {
    return { ok: false, error: { code: 'NOT_FOUND', message: 'Không tìm thấy nhãn' } };
  }

  const touchesProtectedField =
    patch.name !== undefined ||
    patch.color !== undefined ||
    patch.emoji !== undefined ||
    patch.description !== undefined ||
    patch.archivedAt !== undefined;

  if (existing.managedBy === 'zalo_sync' && touchesProtectedField) {
    return {
      ok: false,
      error: {
        code: 'ZALO_MANAGED',
        message: 'Nhãn được đồng bộ từ Zalo — không thể sửa trực tiếp',
      },
    };
  }

  const data: Prisma.CrmTagUpdateInput = {};

  if (patch.name !== undefined) {
    const nameCheck = validateTagName(patch.name);
    if (!nameCheck.ok) {
      return { ok: false, error: { code: 'INVALID_NAME', message: nameCheck.error } };
    }
    data.name = nameCheck.display;
    data.normalizedName = nameCheck.normalized;
  }
  if (patch.color !== undefined) {
    if (!validateColor(patch.color)) {
      return { ok: false, error: { code: 'INVALID_COLOR', message: 'Màu phải có dạng #RRGGBB' } };
    }
    data.color = patch.color;
  }
  if (patch.emoji !== undefined) data.emoji = patch.emoji;
  if (patch.description !== undefined) data.description = patch.description;
  if (patch.order !== undefined) data.order = patch.order;
  if (patch.archivedAt !== undefined) data.archivedAt = patch.archivedAt;

  if (patch.groupId !== undefined) {
    if (patch.groupId === null) {
      data.group = { disconnect: true };
    } else {
      const group = await prisma.crmTagGroup.findFirst({
        where: { id: patch.groupId, orgId },
        select: { id: true },
      });
      if (!group) {
        return { ok: false, error: { code: 'INVALID_GROUP', message: 'Group không hợp lệ' } };
      }
      data.group = { connect: { id: patch.groupId } };
    }
  }

  try {
    const updated = await prisma.crmTag.update({ where: { id }, data });
    return { ok: true, value: updated };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const existingDup = await prisma.crmTag.findUnique({
        where: {
          orgId_normalizedName: {
            orgId,
            normalizedName: data.normalizedName as string,
          },
        },
        select: { id: true },
      });
      return {
        ok: false,
        error: {
          code: 'TAG_DUPLICATE',
          message: 'Nhãn trùng tên với nhãn khác (không phân biệt hoa thường)',
          existingTagId: existingDup?.id ?? '',
        },
      };
    }
    throw err;
  }
}

// ── Archive (soft delete) ────────────────────────────────────────────────────

export async function archiveTag(
  orgId: string,
  id: string,
): Promise<ServiceResult<Awaited<ReturnType<typeof prisma.crmTag.update>>>> {
  const existing = await prisma.crmTag.findFirst({ where: { id, orgId } });
  if (!existing) {
    return { ok: false, error: { code: 'NOT_FOUND', message: 'Không tìm thấy nhãn' } };
  }
  if (existing.managedBy === 'zalo_sync') {
    return {
      ok: false,
      error: {
        code: 'ZALO_MANAGED',
        message: 'Nhãn được đồng bộ từ Zalo — không thể lưu trữ trực tiếp',
      },
    };
  }
  // Idempotent — if already archived, return the existing row.
  if (existing.archivedAt) return { ok: true, value: existing };

  const updated = await prisma.crmTag.update({
    where: { id },
    data: { archivedAt: new Date(), isActive: false },
  });
  return { ok: true, value: updated };
}

// ── Groups ───────────────────────────────────────────────────────────────────

export async function createTagGroup(
  orgId: string,
  name: string,
): Promise<ServiceResult<Awaited<ReturnType<typeof prisma.crmTagGroup.create>>>> {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (trimmed.length < 1 || trimmed.length > 50) {
    return {
      ok: false,
      error: { code: 'INVALID_NAME', message: 'Tên nhóm phải dài 1-50 ký tự' },
    };
  }

  try {
    const created = await prisma.crmTagGroup.create({
      data: { id: randomUUID(), orgId, name: trimmed },
    });
    return { ok: true, value: created };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return {
        ok: false,
        error: { code: 'INVALID_NAME', message: 'Nhóm đã tồn tại với tên này' },
      };
    }
    throw err;
  }
}

// ── ContactTag — the core dual-write surface ─────────────────────────────────

/**
 * Replace a contact's tag set. Computes the diff so we only insert/delete
 * what changed.
 *
 * Validations:
 * - Every `tagId` must belong to `orgId`.
 * - No archived tag may appear in the new set.
 *
 * Activity logging is left to the caller because we don't know the action
 * context here (sale-driven vs keyword-rule vs Zalo-sync).
 */
export async function setContactTags(
  orgId: string,
  contactId: string,
  tagIds: string[],
  userId: string | null,
): Promise<ServiceResult<{ tagIds: string[] }>> {
  const contact = await prisma.contact.findFirst({
    where: { id: contactId, orgId },
    select: { id: true },
  });
  if (!contact) {
    return { ok: false, error: { code: 'NOT_FOUND', message: 'Không tìm thấy khách hàng' } };
  }

  // De-duplicate while preserving order so equality checks are stable.
  const desiredIds = Array.from(new Set(tagIds.filter((s) => typeof s === 'string' && s.length > 0)));

  // Validate every tagId exists, belongs to org, isn't archived.
  let desiredTags: { id: string; name: string }[] = [];
  if (desiredIds.length > 0) {
    const found = await prisma.crmTag.findMany({
      where: { id: { in: desiredIds }, orgId },
      select: { id: true, name: true, archivedAt: true },
    });
    if (found.length !== desiredIds.length) {
      return {
        ok: false,
        error: {
          code: 'INVALID_TAG_ID',
          message: 'Một hoặc nhiều tagId không hợp lệ (sai org hoặc không tồn tại)',
        },
      };
    }
    const archived = found.find((t) => t.archivedAt !== null);
    if (archived) {
      return {
        ok: false,
        error: { code: 'TAG_ARCHIVED', message: `Nhãn "${archived.name}" đã được lưu trữ` },
      };
    }
    desiredTags = found.map((t) => ({ id: t.id, name: t.name }));
  }

  const current = await prisma.contactTag.findMany({
    where: { contactId },
    select: { tagId: true },
  });
  const currentIds = new Set(current.map((c) => c.tagId));
  const desiredSet = new Set(desiredIds);

  const toAdd = desiredIds.filter((id) => !currentIds.has(id));
  const toRemove = [...currentIds].filter((id) => !desiredSet.has(id));

  // Suppress unused-var warning — desiredTags is the validated lookup result
  // (kept for any future per-name side effects); not used directly after the
  // legacy JSON mirror was removed in Phase C.
  void desiredTags;

  await prisma.$transaction(async (tx) => {
    if (toRemove.length > 0) {
      await tx.contactTag.deleteMany({
        where: { contactId, tagId: { in: toRemove } },
      });
      await tx.crmTag.updateMany({
        where: { id: { in: toRemove }, orgId, usageCount: { gt: 0 } },
        data: { usageCount: { decrement: 1 } },
      });
    }
    if (toAdd.length > 0) {
      await tx.contactTag.createMany({
        data: toAdd.map((tagId) => ({
          contactId,
          tagId,
          addedByUserId: userId,
        })),
        skipDuplicates: true,
      });
      await tx.crmTag.updateMany({
        where: { id: { in: toAdd }, orgId },
        data: { usageCount: { increment: 1 } },
      });
    }
  });

  return { ok: true, value: { tagIds: desiredIds } };
}

/**
 * Translate an array of tag NAMES (legacy `{ tags: string[] }` body shape)
 * into tag IDs, creating tags on the fly via case-folded upsert.
 *
 * Used by the backward-compat path of `PUT /contacts/:id/tags`.
 *
 * Names that are blank, whitespace-only, non-strings, or > 50 chars are
 * silently skipped so a malformed legacy payload doesn't blow up.
 */
export async function legacyTagsByName(
  orgId: string,
  names: unknown[],
  userId: string | null,
): Promise<string[]> {
  const out: string[] = [];
  const seen = new Set<string>();

  for (const raw of names) {
    const validation = validateTagName(raw);
    if (!validation.ok) continue;
    if (seen.has(validation.normalized)) continue;
    seen.add(validation.normalized);

    // Upsert by (orgId, normalizedName). On the create side userId is recorded
    // implicitly via ContactTag.addedByUserId (we don't store it on CrmTag).
    const tag = await prisma.crmTag.upsert({
      where: {
        orgId_normalizedName: { orgId, normalizedName: validation.normalized },
      },
      create: {
        id: randomUUID(),
        orgId,
        name: validation.display,
        normalizedName: validation.normalized,
      },
      update: {}, // no-op — preserve existing case + color + group
      select: { id: true },
    });
    out.push(tag.id);
    // userId is captured by setContactTags later; not used here.
    void userId;
  }
  return out;
}
