/**
 * Pre-flight read-only audit for feature 0019 Phase B backfill.
 *
 * Goals (SPEC §5 Phase B Step B.1):
 * - Show how many contacts have non-empty tag arrays per org.
 * - Bucket every unique tag string into valid / whitespace / oversize /
 *   non_string so the admin can eyeball garbage before running the backfill.
 * - Surface case-collision groups (`"vip"`, `"VIP"`, `"Vip"` all fold to
 *   `vip`) so the admin knows which legacy strings will collapse.
 * - Surface adoption targets — existing `CrmTag` rows whose
 *   `normalizedName` matches a legacy string. The backfill will reuse those.
 *
 * Hard contract: ZERO writes. The DB row counts before and after a
 * pre-flight run must be identical (integration test enforces this).
 *
 * Output: structured JSON at `/tmp/0019-preflight-report.json` plus a
 * human-readable summary on stdout. Capped at ~60s for a 50k-contact org
 * by paginating contacts in 1000-row chunks.
 *
 * Usage: `pnpm db:preflight-tags` or `tsx prisma/scripts/0019-preflight-tags.ts`.
 */
import { writeFile } from 'node:fs/promises';
import { prisma } from '../../src/shared/database/prisma-client.js';
import { normalizeName } from '../../src/modules/crm-tags/crm-tag-helpers.js';

const TAG_NAME_MAX = 50;
const CONTACT_CHUNK_SIZE = 1000;

export interface PreflightOrgReport {
  orgId: string;
  orgName: string;
  contactsTotal: number;
  contactsWithTags: number;
  totalTagOccurrences: number;
  uniqueNormalizedCount: number;
  buckets: {
    valid: number;
    whitespaceOnly: number;
    oversize: number;
    nonString: number;
    nullOrInvalidJson: number;
  };
  /** Case-collision groups — multiple display variants that fold to the same normalizedName. */
  caseCollisions: Array<{ normalizedName: string; variants: string[] }>;
  /** Normalized names that already have a CrmTag row — backfill will adopt these. */
  existingCrmTagAdoptions: Array<{ normalizedName: string; existingTagId: string }>;
  /** Estimated CrmTag rows the backfill would create after dedup + adoption. */
  estimatedNewCrmTagRows: number;
}

export interface PreflightReport {
  generatedAt: string;
  orgs: PreflightOrgReport[];
  summary: {
    orgsScanned: number;
    contactsScanned: number;
    contactsWithTags: number;
    uniqueNormalizedNames: number;
    estimatedNewCrmTagRows: number;
  };
}

/**
 * Run the pre-flight audit. Exported so tests can call it directly without
 * spawning a subprocess.
 */
export async function runPreflight(): Promise<PreflightReport> {
  const orgs = await prisma.organization.findMany({
    select: { id: true, name: true },
    orderBy: { createdAt: 'asc' },
  });

  const orgReports: PreflightOrgReport[] = [];

  for (const org of orgs) {
    orgReports.push(await scanOrg(org.id, org.name));
  }

  const report: PreflightReport = {
    generatedAt: new Date().toISOString(),
    orgs: orgReports,
    summary: {
      orgsScanned: orgReports.length,
      contactsScanned: orgReports.reduce((s, r) => s + r.contactsTotal, 0),
      contactsWithTags: orgReports.reduce((s, r) => s + r.contactsWithTags, 0),
      uniqueNormalizedNames: orgReports.reduce((s, r) => s + r.uniqueNormalizedCount, 0),
      estimatedNewCrmTagRows: orgReports.reduce((s, r) => s + r.estimatedNewCrmTagRows, 0),
    },
  };

  return report;
}

async function scanOrg(orgId: string, orgName: string): Promise<PreflightOrgReport> {
  const contactsTotal = await prisma.contact.count({ where: { orgId } });

  // Aggregator state per org
  let contactsWithTags = 0;
  let totalTagOccurrences = 0;
  const buckets = {
    valid: 0,
    whitespaceOnly: 0,
    oversize: 0,
    nonString: 0,
    nullOrInvalidJson: 0,
  };
  // normalizedName → set of display variants observed
  const variantsByNormalized = new Map<string, Set<string>>();

  // Paginate in 1000-row chunks so we don't OOM on big orgs.
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

    for (const row of batch) {
      const tagsValue = row.tags;
      if (tagsValue === null || tagsValue === undefined) {
        buckets.nullOrInvalidJson += 1;
        continue;
      }
      if (!Array.isArray(tagsValue)) {
        buckets.nullOrInvalidJson += 1;
        continue;
      }
      if (tagsValue.length === 0) continue;

      contactsWithTags += 1;
      for (const entry of tagsValue) {
        totalTagOccurrences += 1;
        if (typeof entry !== 'string') {
          buckets.nonString += 1;
          continue;
        }
        const trimmed = entry.trim();
        if (trimmed.length === 0) {
          buckets.whitespaceOnly += 1;
          continue;
        }
        let display = trimmed;
        if (display.length > TAG_NAME_MAX) {
          buckets.oversize += 1;
          display = display.slice(0, TAG_NAME_MAX);
        } else {
          buckets.valid += 1;
        }
        const normalized = normalizeName(display);
        if (normalized.length === 0) {
          buckets.whitespaceOnly += 1;
          continue;
        }
        let set = variantsByNormalized.get(normalized);
        if (!set) {
          set = new Set();
          variantsByNormalized.set(normalized, set);
        }
        set.add(display);
      }
    }

    cursor = batch[batch.length - 1]?.id;
    if (batch.length < CONTACT_CHUNK_SIZE) break;
  }

  // Compute case collisions — normalizedName with > 1 display variant.
  const caseCollisions: Array<{ normalizedName: string; variants: string[] }> = [];
  for (const [normalized, variants] of variantsByNormalized.entries()) {
    if (variants.size > 1) {
      caseCollisions.push({
        normalizedName: normalized,
        variants: Array.from(variants).sort(),
      });
    }
  }
  caseCollisions.sort((a, b) => a.normalizedName.localeCompare(b.normalizedName));

  // Existing CrmTag rows that match a normalizedName — backfill will adopt these.
  const normalizedList = Array.from(variantsByNormalized.keys());
  let existingCrmTagAdoptions: Array<{ normalizedName: string; existingTagId: string }> = [];
  if (normalizedList.length > 0) {
    const existing = await prisma.crmTag.findMany({
      where: { orgId, normalizedName: { in: normalizedList } },
      select: { id: true, normalizedName: true },
    });
    existingCrmTagAdoptions = existing
      .map((e) => ({ normalizedName: e.normalizedName, existingTagId: e.id }))
      .sort((a, b) => a.normalizedName.localeCompare(b.normalizedName));
  }

  const uniqueNormalizedCount = variantsByNormalized.size;
  const estimatedNewCrmTagRows = uniqueNormalizedCount - existingCrmTagAdoptions.length;

  return {
    orgId,
    orgName,
    contactsTotal,
    contactsWithTags,
    totalTagOccurrences,
    uniqueNormalizedCount,
    buckets,
    caseCollisions,
    existingCrmTagAdoptions,
    estimatedNewCrmTagRows,
  };
}

function printSummary(report: PreflightReport): void {
  // Intentional stdout output for CLI users — this script is a one-shot ops tool.
  const out = process.stdout;
  out.write('\n');
  out.write('═══════════════════════════════════════════════════════════════\n');
  out.write(' Feature 0019 Phase B — Pre-flight report\n');
  out.write(`  generated at: ${report.generatedAt}\n`);
  out.write('═══════════════════════════════════════════════════════════════\n\n');

  out.write(`Orgs scanned:                 ${report.summary.orgsScanned}\n`);
  out.write(`Contacts scanned:             ${report.summary.contactsScanned}\n`);
  out.write(`Contacts with tags:           ${report.summary.contactsWithTags}\n`);
  out.write(`Unique normalized names:      ${report.summary.uniqueNormalizedNames}\n`);
  out.write(`Estimated new CrmTag rows:    ${report.summary.estimatedNewCrmTagRows}\n\n`);

  for (const org of report.orgs) {
    out.write(`── ${org.orgName} (${org.orgId}) ──\n`);
    out.write(`  contacts: ${org.contactsTotal} (${org.contactsWithTags} with tags)\n`);
    out.write(`  tag occurrences: ${org.totalTagOccurrences}\n`);
    out.write(`  unique normalized: ${org.uniqueNormalizedCount}\n`);
    out.write(
      `  buckets — valid=${org.buckets.valid}  whitespace=${org.buckets.whitespaceOnly}  ` +
        `oversize=${org.buckets.oversize}  non_string=${org.buckets.nonString}  ` +
        `null_or_invalid_json=${org.buckets.nullOrInvalidJson}\n`,
    );
    if (org.caseCollisions.length > 0) {
      out.write(`  case collisions: ${org.caseCollisions.length}\n`);
      for (const c of org.caseCollisions.slice(0, 5)) {
        out.write(`    "${c.normalizedName}" ← [${c.variants.map((v) => `"${v}"`).join(', ')}]\n`);
      }
      if (org.caseCollisions.length > 5) {
        out.write(`    ... (${org.caseCollisions.length - 5} more in JSON report)\n`);
      }
    }
    if (org.existingCrmTagAdoptions.length > 0) {
      out.write(
        `  existing CrmTag rows to adopt: ${org.existingCrmTagAdoptions.length} (no dup created)\n`,
      );
    }
    out.write(`  estimated new CrmTag rows: ${org.estimatedNewCrmTagRows}\n\n`);
  }

  out.write(`Full JSON report written to /tmp/0019-preflight-report.json\n\n`);
}

async function main(): Promise<void> {
  try {
    const report = await runPreflight();
    await writeFile('/tmp/0019-preflight-report.json', JSON.stringify(report, null, 2), 'utf8');
    printSummary(report);
  } finally {
    await prisma.$disconnect();
  }
}

// `tsx prisma/scripts/0019-preflight-tags.ts` → run main. When imported by
// tests, `runPreflight` is invoked directly and main() is skipped.
const invokedDirectly =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('0019-preflight-tags.ts');
if (invokedDirectly) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[preflight] fatal:', err);
    process.exit(1);
  });
}
