/**
 * One-shot, idempotent backfill from `contact.tags` Json strings into
 * `CrmTag` + `ContactTag`. Feature 0019 Phase B Step B.2.
 *
 * Contract:
 * - **Idempotent** — running twice on the same data produces 0 new rows,
 *   no `usageCount` drift, no exceptions.
 * - **Case-folding** — `"VIP" / "vip" / "Vip"` collapse into a single
 *   CrmTag via the unique `(orgId, normalizedName)` constraint.
 * - **Adopts existing CrmTag rows** — if a Phase A user already created
 *   a CrmTag whose `normalizedName` matches a legacy string, the backfill
 *   reuses it (no duplicate; existing color / group preserved).
 * - **Per-org transaction** — one org failing does not roll back others.
 * - **Defensive parsing** — null / whitespace / non-string / oversize
 *   strings are skipped (or truncated to 50 chars) with structured warnings.
 *
 * CLI:
 * ```
 * tsx prisma/scripts/0019-backfill-tags.ts                   # all orgs
 * tsx prisma/scripts/0019-backfill-tags.ts --dry-run         # rollback at end
 * tsx prisma/scripts/0019-backfill-tags.ts --org-id=<uuid>   # single org
 * ```
 *
 * Output: `/tmp/0019-backfill-report.json` with counters + warnings.
 */
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { prisma as defaultPrisma } from '../../src/shared/database/prisma-client.js';
import { normalizeName } from '../../src/modules/crm-tags/crm-tag-helpers.js';

const TAG_NAME_MAX = 50;
const CONTACT_CHUNK_SIZE = 100;
const DEFAULT_COLOR = '#9E9E9E';

type PrismaLike = typeof defaultPrisma;

export interface BackfillWarning {
  orgId: string;
  contactId: string;
  /** What we found that wasn't a clean string tag. */
  reason:
    | 'tags_null_or_not_array'
    | 'whitespace_only'
    | 'non_string'
    | 'oversize_truncated'
    | 'normalized_empty';
  /** Original raw value for diagnostics (best-effort string form). */
  rawSample?: string;
}

export interface BackfillOrgResult {
  orgId: string;
  orgName: string;
  contactsScanned: number;
  contactsWithValidTags: number;
  crmTagsBefore: number;
  crmTagsAfter: number;
  crmTagsCreated: number;
  contactTagsBefore: number;
  contactTagsAfter: number;
  contactTagsCreated: number;
  warnings: BackfillWarning[];
}

export interface BackfillReport {
  generatedAt: string;
  dryRun: boolean;
  orgsProcessed: BackfillOrgResult[];
  orgsFailed: Array<{ orgId: string; error: string }>;
  totals: {
    crmTagsCreated: number;
    contactTagsCreated: number;
    warnings: number;
  };
}

export interface RunBackfillOptions {
  orgId?: string;
  dryRun?: boolean;
  /** Inject a Prisma client (tests pass the testcontainer-bound client). */
  prismaClient?: PrismaLike;
}

/**
 * Build the normalized-name → display map for a single contact, applying
 * defensive parsing rules. Returns the list of warnings collected so the
 * caller can report them per-org.
 */
function parseContactTags(
  orgId: string,
  contactId: string,
  raw: unknown,
): { names: Map<string, string>; warnings: BackfillWarning[] } {
  const warnings: BackfillWarning[] = [];
  const names = new Map<string, string>();

  if (!Array.isArray(raw)) {
    // Any non-array shape (null, undefined, number, object, etc.) is a sign
    // that legacy data didn't round-trip through `setContactTags` — surface
    // it so admins can audit. We still continue without crashing.
    warnings.push({
      orgId,
      contactId,
      reason: 'tags_null_or_not_array',
      rawSample: safeStringify(raw),
    });
    return { names, warnings };
  }

  for (const entry of raw) {
    if (typeof entry !== 'string') {
      warnings.push({
        orgId,
        contactId,
        reason: 'non_string',
        rawSample: safeStringify(entry),
      });
      continue;
    }
    const trimmed = entry.trim();
    if (trimmed.length === 0) {
      warnings.push({ orgId, contactId, reason: 'whitespace_only' });
      continue;
    }
    let display = trimmed;
    if (display.length > TAG_NAME_MAX) {
      warnings.push({
        orgId,
        contactId,
        reason: 'oversize_truncated',
        rawSample: display.slice(0, 80),
      });
      display = display.slice(0, TAG_NAME_MAX);
    }
    const normalized = normalizeName(display);
    if (normalized.length === 0) {
      warnings.push({ orgId, contactId, reason: 'normalized_empty', rawSample: display });
      continue;
    }
    // First display variant wins. Later variants for the same normalized
    // name are silently folded — case collisions are reported by pre-flight.
    if (!names.has(normalized)) names.set(normalized, display);
  }

  return { names, warnings };
}

function safeStringify(v: unknown): string {
  try {
    if (typeof v === 'string') return v.slice(0, 80);
    return JSON.stringify(v).slice(0, 80);
  } catch {
    return '[unstringifiable]';
  }
}

/**
 * Process a single org. The mutation happens inside a transaction. In
 * dry-run mode we deliberately throw a sentinel error at the end of the
 * transaction so Prisma rolls back — the catch path translates it to a
 * normal "success but rolled back" result.
 */
async function processOrg(
  prisma: PrismaLike,
  orgId: string,
  orgName: string,
  dryRun: boolean,
): Promise<BackfillOrgResult> {
  const crmTagsBefore = await prisma.crmTag.count({ where: { orgId } });
  const contactTagsBefore = await prisma.contactTag.count({
    where: { tag: { orgId } },
  });

  // Step 1 — read every contact's tags. We do this OUTSIDE the transaction
  // because read-only Prisma calls hold no locks and a 50k-row scan inside
  // a write transaction would chew up walbuffers.
  const allWarnings: BackfillWarning[] = [];
  // contactId → Map<normalized, display>
  const perContact = new Map<string, Map<string, string>>();
  // org-wide aggregate: normalized → first-seen display
  const orgUniqueNames = new Map<string, string>();
  let contactsScanned = 0;
  let cursor: string | undefined = undefined;

  while (true) {
    const batch: { id: string; tags: unknown }[] = await prisma.contact.findMany({
      where: { orgId },
      select: { id: true, tags: true },
      orderBy: { id: 'asc' },
      take: CONTACT_CHUNK_SIZE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    if (batch.length === 0) break;
    contactsScanned += batch.length;

    for (const row of batch) {
      const { names, warnings } = parseContactTags(orgId, row.id, row.tags);
      allWarnings.push(...warnings);
      if (names.size > 0) {
        perContact.set(row.id, names);
        for (const [n, d] of names.entries()) {
          if (!orgUniqueNames.has(n)) orgUniqueNames.set(n, d);
        }
      }
    }

    cursor = batch[batch.length - 1]?.id;
    if (batch.length < CONTACT_CHUNK_SIZE) break;
  }

  const contactsWithValidTags = perContact.size;

  // Step 2 — upsert CrmTag rows + create ContactTag links inside one txn.
  // We throw `DRY_RUN_SENTINEL` at the end if dryRun=true so Prisma rolls
  // back. That gives us "what would happen" diagnostics for free.
  const DRY_RUN_SENTINEL = Symbol('dry_run_rollback');
  let txnError: unknown = null;
  // Snapshot tagId map per normalized name so we can build ContactTag rows.
  let tagIdByNormalized = new Map<string, string>();

  try {
    await prisma.$transaction(
      async (tx) => {
        // Adopt existing CrmTag rows first — these define the tagId we'll
        // use and preserve their existing color / group / managedBy.
        const normalizedList = Array.from(orgUniqueNames.keys());
        if (normalizedList.length > 0) {
          const existing = await tx.crmTag.findMany({
            where: { orgId, normalizedName: { in: normalizedList } },
            select: { id: true, normalizedName: true },
          });
          for (const e of existing) {
            tagIdByNormalized.set(e.normalizedName, e.id);
          }

          // Step 2a — create CrmTag rows for normalized names that don't
          // exist yet. Single createMany with skipDuplicates makes the
          // re-run case safe: the @@unique(orgId, normalizedName) will
          // silently drop duplicates.
          const toCreate: Array<{
            id: string;
            orgId: string;
            name: string;
            normalizedName: string;
            color: string;
          }> = [];
          for (const [normalized, display] of orgUniqueNames.entries()) {
            if (tagIdByNormalized.has(normalized)) continue;
            toCreate.push({
              id: randomUUID(),
              orgId,
              name: display,
              normalizedName: normalized,
              color: DEFAULT_COLOR,
            });
          }
          if (toCreate.length > 0) {
            await tx.crmTag.createMany({ data: toCreate, skipDuplicates: true });
            // Re-read all rows for these normalized names so we have the
            // canonical id (either pre-existing or just-created).
            const fresh = await tx.crmTag.findMany({
              where: { orgId, normalizedName: { in: normalizedList } },
              select: { id: true, normalizedName: true },
            });
            tagIdByNormalized = new Map(fresh.map((t) => [t.normalizedName, t.id]));
          }
        }

        // Step 2b — bulk insert ContactTag rows, deduped by PK.
        const contactTagRows: Array<{ contactId: string; tagId: string }> = [];
        for (const [contactId, names] of perContact.entries()) {
          for (const normalized of names.keys()) {
            const tagId = tagIdByNormalized.get(normalized);
            if (!tagId) continue; // shouldn't happen — every name was upserted above
            contactTagRows.push({ contactId, tagId });
          }
        }
        if (contactTagRows.length > 0) {
          // createMany with skipDuplicates collapses re-runs into a no-op
          // for the PK collision (contactId, tagId).
          await tx.contactTag.createMany({
            data: contactTagRows,
            skipDuplicates: true,
          });
        }

        // Step 2c — recompute usageCount from the junction. We never trust
        // the previous counter because Phase A writes + this backfill
        // could otherwise double-count.
        const counts = await tx.contactTag.groupBy({
          by: ['tagId'],
          where: { tag: { orgId } },
          _count: { tagId: true },
        });
        // Build a complete map: tagId → 0 unless we found a count.
        const countByTagId = new Map<string, number>();
        for (const c of counts) {
          countByTagId.set(c.tagId, c._count.tagId);
        }
        // Reset all the org's CrmTag.usageCount to match reality. We do
        // this in two passes — first zero out anything that lost all its
        // links, then set the actual counts.
        await tx.crmTag.updateMany({
          where: { orgId, id: { notIn: counts.map((c) => c.tagId) } },
          data: { usageCount: 0 },
        });
        for (const [tagId, count] of countByTagId.entries()) {
          await tx.crmTag.update({ where: { id: tagId }, data: { usageCount: count } });
        }

        // In dry-run mode, throw to roll back. We catch the sentinel
        // outside the transaction.
        if (dryRun) throw DRY_RUN_SENTINEL;
      },
      { timeout: 60_000, maxWait: 10_000 },
    );
  } catch (err) {
    if (err === DRY_RUN_SENTINEL) {
      // Expected — dry-run rollback. Treat as success.
    } else {
      txnError = err;
    }
  }

  if (txnError) {
    throw txnError;
  }

  const crmTagsAfter = await prisma.crmTag.count({ where: { orgId } });
  const contactTagsAfter = await prisma.contactTag.count({
    where: { tag: { orgId } },
  });

  return {
    orgId,
    orgName,
    contactsScanned,
    contactsWithValidTags,
    crmTagsBefore,
    crmTagsAfter,
    crmTagsCreated: crmTagsAfter - crmTagsBefore,
    contactTagsBefore,
    contactTagsAfter,
    contactTagsCreated: contactTagsAfter - contactTagsBefore,
    warnings: allWarnings,
  };
}

/**
 * Public entry point — tests call this directly with a testcontainer prisma
 * client. CLI main() resolves the default client and forwards.
 */
export async function runBackfill(opts: RunBackfillOptions = {}): Promise<BackfillReport> {
  const prisma = opts.prismaClient ?? defaultPrisma;
  const dryRun = opts.dryRun ?? false;

  const where = opts.orgId ? { id: opts.orgId } : undefined;
  const orgs = await prisma.organization.findMany({
    where,
    select: { id: true, name: true },
    orderBy: { createdAt: 'asc' },
  });

  const orgsProcessed: BackfillOrgResult[] = [];
  const orgsFailed: Array<{ orgId: string; error: string }> = [];

  for (const org of orgs) {
    try {
      const result = await processOrg(prisma, org.id, org.name, dryRun);
      orgsProcessed.push(result);
    } catch (err) {
      orgsFailed.push({
        orgId: org.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    dryRun,
    orgsProcessed,
    orgsFailed,
    totals: {
      crmTagsCreated: orgsProcessed.reduce((s, o) => s + o.crmTagsCreated, 0),
      contactTagsCreated: orgsProcessed.reduce((s, o) => s + o.contactTagsCreated, 0),
      warnings: orgsProcessed.reduce((s, o) => s + o.warnings.length, 0),
    },
  };
}

function printSummary(report: BackfillReport): void {
  const out = process.stdout;
  out.write('\n');
  out.write('═══════════════════════════════════════════════════════════════\n');
  out.write(` Feature 0019 Phase B — Backfill report ${report.dryRun ? '(DRY-RUN)' : ''}\n`);
  out.write(`  generated at: ${report.generatedAt}\n`);
  out.write('═══════════════════════════════════════════════════════════════\n\n');

  out.write(`Orgs processed:              ${report.orgsProcessed.length}\n`);
  out.write(`Orgs failed:                 ${report.orgsFailed.length}\n`);
  out.write(`CrmTag rows created:         ${report.totals.crmTagsCreated}\n`);
  out.write(`ContactTag rows created:     ${report.totals.contactTagsCreated}\n`);
  out.write(`Warnings:                    ${report.totals.warnings}\n\n`);

  for (const org of report.orgsProcessed) {
    out.write(`── ${org.orgName} (${org.orgId}) ──\n`);
    out.write(`  contacts scanned: ${org.contactsScanned} (${org.contactsWithValidTags} with valid tags)\n`);
    out.write(`  CrmTag: ${org.crmTagsBefore} → ${org.crmTagsAfter} (+${org.crmTagsCreated})\n`);
    out.write(`  ContactTag: ${org.contactTagsBefore} → ${org.contactTagsAfter} (+${org.contactTagsCreated})\n`);
    if (org.warnings.length > 0) {
      out.write(`  warnings: ${org.warnings.length}\n`);
      // Bucket warnings by reason for the human eye.
      const bucket = new Map<string, number>();
      for (const w of org.warnings) bucket.set(w.reason, (bucket.get(w.reason) ?? 0) + 1);
      for (const [reason, count] of bucket.entries()) {
        out.write(`    ${reason}: ${count}\n`);
      }
    }
    out.write('\n');
  }

  if (report.orgsFailed.length > 0) {
    out.write('Failed orgs:\n');
    for (const f of report.orgsFailed) {
      out.write(`  ${f.orgId} — ${f.error}\n`);
    }
    out.write('\n');
  }

  out.write(`Full JSON report at /tmp/0019-backfill-report.json\n\n`);
}

function parseArgs(argv: string[]): { dryRun: boolean; orgId?: string } {
  let dryRun = false;
  let orgId: string | undefined;
  for (const arg of argv) {
    if (arg === '--dry-run') dryRun = true;
    else if (arg.startsWith('--org-id=')) orgId = arg.slice('--org-id='.length);
  }
  return { dryRun, orgId };
}

async function main(): Promise<void> {
  const { dryRun, orgId } = parseArgs(process.argv.slice(2));
  try {
    const report = await runBackfill({ dryRun, orgId });
    await writeFile('/tmp/0019-backfill-report.json', JSON.stringify(report, null, 2), 'utf8');
    printSummary(report);
    if (report.orgsFailed.length > 0) process.exit(2);
  } finally {
    await defaultPrisma.$disconnect();
  }
}

const invokedDirectly =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('0019-backfill-tags.ts');
if (invokedDirectly) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[backfill] fatal:', err);
    process.exit(1);
  });
}
