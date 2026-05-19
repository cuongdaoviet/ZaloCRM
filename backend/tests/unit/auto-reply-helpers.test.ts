import { describe, it, expect } from 'vitest';
import {
  validateRuleInput,
  localTimeInZone,
  isInActiveWindow,
  passesStaticGates,
  substitutePlaceholders,
  type RuleSnapshot,
} from '../../src/modules/auto-reply/auto-reply-helpers.js';

describe('validateRuleInput', () => {
  it('accepts a valid payload', () => {
    const result = validateRuleInput({
      enabled: true,
      daysOfWeek: 62,
      startMinute: 480,
      endMinute: 1080,
      timezone: 'Asia/Ho_Chi_Minh',
      message: 'hi',
      cooldownMinutes: 240,
    });
    expect(result.ok).toBe(true);
  });

  it('fills sensible defaults when fields are missing', () => {
    const result = validateRuleInput({ message: 'x' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.enabled).toBe(true);
      expect(result.value.daysOfWeek).toBe(62);
      expect(result.value.startMinute).toBe(480);
      expect(result.value.endMinute).toBe(1080);
      expect(result.value.timezone).toBe('Asia/Ho_Chi_Minh');
      expect(result.value.cooldownMinutes).toBe(240);
    }
  });

  it('rejects start >= end', () => {
    const result = validateRuleInput({
      startMinute: 1080,
      endMinute: 480,
      message: 'x',
    });
    expect(result.ok).toBe(false);
  });

  it('rejects daysOfWeek out of range', () => {
    expect(validateRuleInput({ daysOfWeek: 200, message: 'x' }).ok).toBe(false);
    expect(validateRuleInput({ daysOfWeek: -1, message: 'x' }).ok).toBe(false);
  });

  it('rejects invalid timezone', () => {
    const result = validateRuleInput({ timezone: 'Mars/Olympus', message: 'x' });
    expect(result.ok).toBe(false);
  });

  it('rejects empty / over-long message', () => {
    expect(validateRuleInput({ message: '' }).ok).toBe(false);
    expect(validateRuleInput({ message: 'x'.repeat(1001) }).ok).toBe(false);
  });

  it('rejects cooldown out of range', () => {
    expect(validateRuleInput({ message: 'x', cooldownMinutes: 0 }).ok).toBe(false);
    expect(validateRuleInput({ message: 'x', cooldownMinutes: 10081 }).ok).toBe(false);
  });

  it('rejects non-object body', () => {
    expect(validateRuleInput(null).ok).toBe(false);
    expect(validateRuleInput('string').ok).toBe(false);
  });
});

describe('localTimeInZone', () => {
  it('returns matching day + minute for UTC', () => {
    // 2026-01-05 (Mon) 14:30 UTC
    const date = new Date(Date.UTC(2026, 0, 5, 14, 30));
    const local = localTimeInZone(date, 'UTC');
    expect(local.dayOfWeek).toBe(1); // Monday
    expect(local.minuteOfDay).toBe(14 * 60 + 30);
  });

  it('shifts forward 7 hours for Asia/Ho_Chi_Minh', () => {
    // 2026-01-05 01:00 UTC → 2026-01-05 08:00 ICT (still Monday)
    const date = new Date(Date.UTC(2026, 0, 5, 1, 0));
    const local = localTimeInZone(date, 'Asia/Ho_Chi_Minh');
    expect(local.dayOfWeek).toBe(1);
    expect(local.minuteOfDay).toBe(8 * 60);
  });

  it('can roll the day forward when zone is east of UTC', () => {
    // 2026-01-04 (Sun) 22:00 UTC → 2026-01-05 (Mon) 05:00 ICT
    const date = new Date(Date.UTC(2026, 0, 4, 22, 0));
    const local = localTimeInZone(date, 'Asia/Ho_Chi_Minh');
    expect(local.dayOfWeek).toBe(1); // Monday
    expect(local.minuteOfDay).toBe(5 * 60);
  });
});

describe('isInActiveWindow', () => {
  // Mon-Fri 08:00-18:00 ICT
  const rule: RuleSnapshot = {
    enabled: true,
    daysOfWeek: 62,
    startMinute: 480,
    endMinute: 1080,
    timezone: 'Asia/Ho_Chi_Minh',
  };

  it('is active on Mon 10:00 ICT', () => {
    // 2026-01-05 (Mon) 03:00 UTC = 10:00 ICT
    const date = new Date(Date.UTC(2026, 0, 5, 3, 0));
    expect(isInActiveWindow(rule, date)).toBe(true);
  });

  it('is NOT active on Mon 22:00 ICT (after hours)', () => {
    // 2026-01-05 (Mon) 15:00 UTC = 22:00 ICT
    const date = new Date(Date.UTC(2026, 0, 5, 15, 0));
    expect(isInActiveWindow(rule, date)).toBe(false);
  });

  it('is NOT active on Sunday regardless of hour', () => {
    // 2026-01-04 (Sun) 04:00 UTC = 11:00 ICT
    const date = new Date(Date.UTC(2026, 0, 4, 4, 0));
    expect(isInActiveWindow(rule, date)).toBe(false);
  });

  it('end minute is exclusive — 18:00 is OUT', () => {
    // 2026-01-05 (Mon) 11:00 UTC = 18:00 ICT
    const date = new Date(Date.UTC(2026, 0, 5, 11, 0));
    expect(isInActiveWindow(rule, date)).toBe(false);
  });
});

describe('passesStaticGates', () => {
  const baseRule: RuleSnapshot = {
    enabled: true,
    daysOfWeek: 62,
    startMinute: 480,
    endMinute: 1080,
    timezone: 'Asia/Ho_Chi_Minh',
  };
  const afterHours = new Date(Date.UTC(2026, 0, 5, 15, 0)); // Mon 22:00 ICT

  it('passes for after-hours user message from contact', () => {
    expect(
      passesStaticGates(baseRule, { threadType: 'user', isSelf: false }, afterHours),
    ).toBe(true);
  });

  it('blocks when rule disabled', () => {
    expect(
      passesStaticGates(
        { ...baseRule, enabled: false },
        { threadType: 'user', isSelf: false },
        afterHours,
      ),
    ).toBe(false);
  });

  it('blocks group threads', () => {
    expect(
      passesStaticGates(baseRule, { threadType: 'group', isSelf: false }, afterHours),
    ).toBe(false);
  });

  it('blocks self messages', () => {
    expect(
      passesStaticGates(baseRule, { threadType: 'user', isSelf: true }, afterHours),
    ).toBe(false);
  });

  it('blocks during active window', () => {
    const inHours = new Date(Date.UTC(2026, 0, 5, 3, 0)); // Mon 10:00 ICT
    expect(
      passesStaticGates(baseRule, { threadType: 'user', isSelf: false }, inHours),
    ).toBe(false);
  });
});

describe('substitutePlaceholders', () => {
  it('replaces both placeholders', () => {
    expect(
      substitutePlaceholders('Chào {{firstName}}, {{contactName}}', {
        fullName: 'Nguyễn Văn A',
      }),
    ).toBe('Chào Nguyễn, Nguyễn Văn A');
  });

  it('handles null contact', () => {
    expect(substitutePlaceholders('Hi {{contactName}}', null)).toBe('Hi ');
  });
});
