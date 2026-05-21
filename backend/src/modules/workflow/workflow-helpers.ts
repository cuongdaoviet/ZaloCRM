/**
 * Pure helpers for the Workflow module (Feature 0037, phase 1).
 *
 * Kept side-effect free so they can be unit-tested without Prisma /
 * Fastify / zca-js. Validation, template-var substitution, and trigger
 * matching live here.
 *
 * Phase 1 scope: 1 trigger type (`inbound_message`), 4 step types
 * (`send_message`, `add_tag`, `assign_user`, `wait`). Linear step list,
 * no branching. Template vars: `{{contactName}}`, `{{firstName}}`,
 * `{{repName}}` — anything else is left as literal (EC-0006).
 */

export const STEP_TYPES = ['send_message', 'add_tag', 'assign_user', 'wait'] as const;
export type StepType = (typeof STEP_TYPES)[number];

export const TRIGGER_TYPES = ['inbound_message'] as const;
export type TriggerType = (typeof TRIGGER_TYPES)[number];

/** 24 hours in ms — BR-0007 re-trigger cooldown */
export const RETRIGGER_COOLDOWN_MS = 24 * 60 * 60 * 1000;

// ── Validated shapes ─────────────────────────────────────────────────────────

export interface InboundTrigger {
  type: 'inbound_message';
  /** Substring match on Message.content (case-insensitive). Optional. */
  messageMatch?: string;
  /** Restrict to contacts in one of these pipeline statuses. Optional. */
  contactStatus?: string[];
  /** Only fire on the contact's very first inbound message. Optional. */
  isFirstInbound?: boolean;
}

export interface SendMessageStep {
  type: 'send_message';
  /** Message body — supports {{contactName}}, {{firstName}}, {{repName}}. */
  content: string;
  /** Optional delay before this step runs, in minutes. */
  delayMinutes?: number;
}

export interface AddTagStep {
  type: 'add_tag';
  /** Display-cased tag name. Will be upserted by normalized name (case-folded). */
  tag: string;
  delayMinutes?: number;
}

export interface AssignUserStep {
  type: 'assign_user';
  /** User.id within the same org. */
  userId: string;
  delayMinutes?: number;
}

export interface WaitStep {
  type: 'wait';
  /** Required delay in minutes for the wait step. */
  delayMinutes: number;
}

export type WorkflowStep = SendMessageStep | AddTagStep | AssignUserStep | WaitStep;

export interface WorkflowInput {
  name: string;
  description: string | null;
  isActive: boolean;
  trigger: InboundTrigger;
  steps: WorkflowStep[];
}

const VALID_CONTACT_STATUSES = new Set([
  'new',
  'contacted',
  'interested',
  'converted',
  'lost',
]);

// ── Validation ──────────────────────────────────────────────────────────────

/**
 * Validate a POST/PUT /workflows body. Returns the cleaned input or a
 * 400-friendly error message. The caller (route) is responsible for
 * per-row authorization checks (org isolation, role, etc).
 */
export function validateWorkflowInput(
  body: unknown,
): { ok: true; value: WorkflowInput } | { ok: false; error: string } {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, error: 'Body không hợp lệ' };
  }
  const b = body as Record<string, unknown>;

  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (name.length < 1 || name.length > 200) {
    return { ok: false, error: 'name phải dài 1-200 ký tự' };
  }

  const description = optionalString(b.description);
  const isActive = b.isActive === undefined ? true : Boolean(b.isActive);

  const trigger = validateTrigger(b.trigger);
  if (!trigger.ok) return trigger;

  const steps = validateSteps(b.steps);
  if (!steps.ok) return steps;

  return {
    ok: true,
    value: {
      name,
      description,
      isActive,
      trigger: trigger.value,
      steps: steps.value,
    },
  };
}

function validateTrigger(
  raw: unknown,
): { ok: true; value: InboundTrigger } | { ok: false; error: string } {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, error: 'trigger phải là object' };
  }
  const t = raw as Record<string, unknown>;
  if (t.type !== 'inbound_message') {
    return { ok: false, error: 'trigger.type chỉ hỗ trợ "inbound_message" (phase 1)' };
  }

  const out: InboundTrigger = { type: 'inbound_message' };

  if (t.messageMatch !== undefined && t.messageMatch !== null && t.messageMatch !== '') {
    if (typeof t.messageMatch !== 'string') {
      return { ok: false, error: 'trigger.messageMatch phải là string' };
    }
    const trimmed = t.messageMatch.trim();
    if (trimmed.length > 200) {
      return { ok: false, error: 'trigger.messageMatch không quá 200 ký tự' };
    }
    if (trimmed.length > 0) out.messageMatch = trimmed;
  }

  if (t.contactStatus !== undefined && t.contactStatus !== null) {
    if (!Array.isArray(t.contactStatus)) {
      return { ok: false, error: 'trigger.contactStatus phải là mảng' };
    }
    const filtered = (t.contactStatus as unknown[]).filter(
      (s): s is string => typeof s === 'string' && VALID_CONTACT_STATUSES.has(s),
    );
    if (filtered.length > 0) out.contactStatus = filtered;
  }

  if (t.isFirstInbound !== undefined && t.isFirstInbound !== null) {
    out.isFirstInbound = Boolean(t.isFirstInbound);
  }

  return { ok: true, value: out };
}

function validateSteps(
  raw: unknown,
): { ok: true; value: WorkflowStep[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) {
    return { ok: false, error: 'steps phải là mảng' };
  }
  if (raw.length === 0) {
    return { ok: false, error: 'steps không được rỗng' };
  }
  if (raw.length > 50) {
    return { ok: false, error: 'steps không quá 50 phần tử (phase 1)' };
  }

  const out: WorkflowStep[] = [];
  for (let i = 0; i < raw.length; i++) {
    const s = raw[i];
    if (typeof s !== 'object' || s === null) {
      return { ok: false, error: `steps[${i}] phải là object` };
    }
    const step = s as Record<string, unknown>;
    if (typeof step.type !== 'string' || !STEP_TYPES.includes(step.type as StepType)) {
      return {
        ok: false,
        error: `steps[${i}].type không hợp lệ (chấp nhận: ${STEP_TYPES.join(', ')})`,
      };
    }

    const delayRaw = step.delayMinutes;
    let delayMinutes = 0;
    if (delayRaw !== undefined && delayRaw !== null) {
      if (typeof delayRaw !== 'number' || !Number.isFinite(delayRaw) || delayRaw < 0) {
        return { ok: false, error: `steps[${i}].delayMinutes phải là số >= 0` };
      }
      if (delayRaw > 60 * 24 * 30) {
        return { ok: false, error: `steps[${i}].delayMinutes không quá 30 ngày` };
      }
      delayMinutes = Math.floor(delayRaw);
    }

    if (step.type === 'send_message') {
      const content = typeof step.content === 'string' ? step.content.trim() : '';
      if (content.length < 1 || content.length > 2000) {
        return { ok: false, error: `steps[${i}].content phải dài 1-2000 ký tự` };
      }
      out.push({ type: 'send_message', content, delayMinutes });
    } else if (step.type === 'add_tag') {
      const tag = typeof step.tag === 'string' ? step.tag.trim() : '';
      if (tag.length < 1 || tag.length > 64) {
        return { ok: false, error: `steps[${i}].tag phải dài 1-64 ký tự` };
      }
      out.push({ type: 'add_tag', tag, delayMinutes });
    } else if (step.type === 'assign_user') {
      const userId = typeof step.userId === 'string' ? step.userId.trim() : '';
      if (userId.length === 0) {
        return { ok: false, error: `steps[${i}].userId bắt buộc` };
      }
      out.push({ type: 'assign_user', userId, delayMinutes });
    } else if (step.type === 'wait') {
      if (delayMinutes < 1) {
        return { ok: false, error: `steps[${i}].delayMinutes >= 1 (wait step)` };
      }
      out.push({ type: 'wait', delayMinutes });
    }
  }

  return { ok: true, value: out };
}

function optionalString(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  return trimmed === '' ? null : trimmed;
}

// ── Trigger matching ────────────────────────────────────────────────────────

export interface TriggerMatchInput {
  content: string | null;
  contactStatus: string | null;
  isFirstInbound: boolean;
}

/**
 * Returns true when the trigger config matches the incoming inbound message.
 * Pure — no DB access. Caller is responsible for sourcing `isFirstInbound`.
 */
export function triggerMatches(trigger: InboundTrigger, input: TriggerMatchInput): boolean {
  if (trigger.type !== 'inbound_message') return false;

  if (trigger.messageMatch) {
    if (!input.content) return false;
    if (!input.content.toLowerCase().includes(trigger.messageMatch.toLowerCase())) {
      return false;
    }
  }

  if (trigger.contactStatus && trigger.contactStatus.length > 0) {
    if (!input.contactStatus) return false;
    if (!trigger.contactStatus.includes(input.contactStatus)) return false;
  }

  if (trigger.isFirstInbound === true && !input.isFirstInbound) return false;

  return true;
}

// ── Template var substitution ───────────────────────────────────────────────

export interface TemplateContext {
  contactName?: string | null;
  repName?: string | null;
}

/**
 * Replace `{{contactName}}`, `{{firstName}}`, and `{{repName}}` in `text`.
 * Unknown vars are left as literal (EC-0006: never silently drop).
 *
 * Output is plain text — safe to pass straight to zca-js. There is no HTML
 * rendering in this path so XSS isn't a concern; but we DO strip newline
 * runs > 5 to defend against injection-style spam payloads (BR-0003 / SPEC
 * §8 implementation note 3).
 */
export function substituteTemplateVars(text: string, ctx: TemplateContext): string {
  const contactName = (ctx.contactName ?? '').trim();
  const firstName = contactName.split(/\s+/)[0] ?? '';
  const repName = (ctx.repName ?? '').trim();

  const out = text
    .replace(/\{\{contactName\}\}/g, contactName)
    .replace(/\{\{firstName\}\}/g, firstName)
    .replace(/\{\{repName\}\}/g, repName);

  // Collapse 6+ newline runs to 2 — defensive against an admin pasting
  // a multi-page template that would look like spam to the recipient.
  return out.replace(/\n{6,}/g, '\n\n');
}

// ── Step log helpers ────────────────────────────────────────────────────────

export interface StepLogEntry {
  idx: number;
  type: StepType;
  status: 'ok' | 'failed' | 'skipped';
  ranAt: string; // ISO
  error?: string;
}

export function appendStepLog(
  current: unknown,
  entry: StepLogEntry,
): StepLogEntry[] {
  const log = Array.isArray(current) ? (current as StepLogEntry[]) : [];
  return [...log, entry];
}

// ── Re-trigger cooldown ─────────────────────────────────────────────────────

/**
 * True when the most recent execution for `(workflowId, contactId)` is
 * within the cooldown window — caller must skip new execution creation
 * (BR-0007).
 */
export function withinCooldown(
  latestStartedAt: Date | null | undefined,
  now: Date = new Date(),
  cooldownMs: number = RETRIGGER_COOLDOWN_MS,
): boolean {
  if (!latestStartedAt) return false;
  return now.getTime() - latestStartedAt.getTime() < cooldownMs;
}
