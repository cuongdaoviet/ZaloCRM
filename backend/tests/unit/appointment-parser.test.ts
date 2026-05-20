/**
 * Unit tests for feature 0017 — Vietnamese appointment fallback parser.
 *
 * All tests pass an explicit `now` to keep date math deterministic.
 * Reference Wednesday: 2026-05-20 14:00 local time.
 */
import { describe, it, expect } from 'vitest';
import { parseAppointmentFromText } from '../../src/modules/contacts/appointment-parser.js';

// 2026-05-20 is a Wednesday (weekday=3). All "next weekday" math anchors here.
const NOW = new Date(2026, 4, 20, 14, 0, 0); // local time

describe('parseAppointmentFromText — null cases', () => {
  it('returns null for empty string', () => {
    expect(parseAppointmentFromText('', NOW)).toBeNull();
  });

  it('returns null for whitespace-only string', () => {
    expect(parseAppointmentFromText('     \n\t  ', NOW)).toBeNull();
  });

  it('returns null for random non-appointment text', () => {
    expect(parseAppointmentFromText('abc xyz random text', NOW)).toBeNull();
  });

  it('returns null when only a greeting is present', () => {
    expect(parseAppointmentFromText('chào shop nha', NOW)).toBeNull();
  });

  it('returns null for non-string input', () => {
    // @ts-expect-error testing runtime guard
    expect(parseAppointmentFromText(null, NOW)).toBeNull();
    // @ts-expect-error testing runtime guard
    expect(parseAppointmentFromText(undefined, NOW)).toBeNull();
  });
});

describe('parseAppointmentFromText — relative days', () => {
  it('"mai" → tomorrow at default 09:00', () => {
    const r = parseAppointmentFromText('hẹn gặp mai nhé', NOW);
    expect(r).not.toBeNull();
    expect(r!.date.getFullYear()).toBe(2026);
    expect(r!.date.getMonth()).toBe(4); // May
    expect(r!.date.getDate()).toBe(21);
    expect(r!.date.getHours()).toBe(9);
    expect(r!.type).toBe('meeting');
  });

  it('"9h sáng mai" → tomorrow at 09:00', () => {
    const r = parseAppointmentFromText('9h sáng mai gặp em nhé', NOW);
    expect(r).not.toBeNull();
    expect(r!.date.getDate()).toBe(21);
    expect(r!.date.getHours()).toBe(9);
    expect(r!.date.getMinutes()).toBe(0);
  });

  it('"hôm nay 17h30" → today at 17:30', () => {
    const r = parseAppointmentFromText('hẹn anh hôm nay 17:30 nhé', NOW);
    expect(r).not.toBeNull();
    expect(r!.date.getDate()).toBe(20);
    expect(r!.date.getHours()).toBe(17);
    expect(r!.date.getMinutes()).toBe(30);
  });

  it('"chiều mai 3 giờ" → tomorrow at 15:00 (PM via "chiều" hint)', () => {
    const r = parseAppointmentFromText('chiều mai 3 giờ gặp nhé', NOW);
    expect(r).not.toBeNull();
    expect(r!.date.getDate()).toBe(21);
    expect(r!.date.getHours()).toBe(15);
  });

  it('"ngày kia" → +2 days', () => {
    const r = parseAppointmentFromText('hẹn gặp ngày kia', NOW);
    expect(r).not.toBeNull();
    expect(r!.date.getDate()).toBe(22);
  });

  it('"3 ngày nữa" → +3 days', () => {
    const r = parseAppointmentFromText('gọi lại 3 ngày nữa nha', NOW);
    expect(r).not.toBeNull();
    expect(r!.date.getDate()).toBe(23);
    expect(r!.type).toBe('call');
  });
});

describe('parseAppointmentFromText — weekdays', () => {
  it('"hẹn 2pm thứ 5" → next Thursday at 14:00', () => {
    // NOW is Wed 2026-05-20, so Thursday is 2026-05-21.
    const r = parseAppointmentFromText('hẹn 2pm thứ 5', NOW);
    expect(r).not.toBeNull();
    expect(r!.date.getDate()).toBe(21);
    expect(r!.date.getMonth()).toBe(4);
    expect(r!.date.getHours()).toBe(14);
  });

  it('"tuần sau" alone → +7 days at 10h', () => {
    // The parser checks "tuần sau" before weekday patterns; combining a weekday
    // with "tuần sau" defers to the relative-week match (=> +7 days). This is
    // an intentional limitation inherited from the reference rule-based parser.
    const r = parseAppointmentFromText('hẹn lúc 10h tuần sau', NOW);
    expect(r).not.toBeNull();
    expect(r!.date.getDate()).toBe(27); // May 20 + 7
    expect(r!.date.getMonth()).toBe(4); // May
    expect(r!.date.getHours()).toBe(10);
  });

  it('"chủ nhật" → upcoming Sunday', () => {
    const r = parseAppointmentFromText('hẹn chủ nhật gặp nhau', NOW);
    expect(r).not.toBeNull();
    expect(r!.date.getDay()).toBe(0);
  });
});

describe('parseAppointmentFromText — absolute dates', () => {
  it('"ngày 20/5 lúc 14h" → 20 May this year at 14:00', () => {
    const r = parseAppointmentFromText('ngày 20/5 lúc 14h gặp nhau', NOW);
    expect(r).not.toBeNull();
    expect(r!.date.getFullYear()).toBe(2026);
    expect(r!.date.getMonth()).toBe(4);
    expect(r!.date.getDate()).toBe(20);
    expect(r!.date.getHours()).toBe(14);
  });

  it('"25/12" → 25 December (this year if upcoming, next year if past)', () => {
    const r = parseAppointmentFromText('hẹn 25/12 gặp anh', NOW);
    expect(r).not.toBeNull();
    expect(r!.date.getMonth()).toBe(11);
    expect(r!.date.getDate()).toBe(25);
    expect(r!.date.getFullYear()).toBe(2026);
  });

  it('past date with no year → rolls over to next year', () => {
    const r = parseAppointmentFromText('hẹn ngày 1/1 nha', NOW);
    expect(r).not.toBeNull();
    expect(r!.date.getMonth()).toBe(0);
    expect(r!.date.getDate()).toBe(1);
    expect(r!.date.getFullYear()).toBe(2027);
  });

  it('"ngày 15 tháng 6" form', () => {
    const r = parseAppointmentFromText('hẹn ngày 15 tháng 6 nha', NOW);
    expect(r).not.toBeNull();
    expect(r!.date.getMonth()).toBe(5);
    expect(r!.date.getDate()).toBe(15);
  });
});

describe('parseAppointmentFromText — type inference', () => {
  it('"gọi điện thoại" → call', () => {
    const r = parseAppointmentFromText('gọi cho em chiều mai', NOW);
    expect(r).not.toBeNull();
    expect(r!.type).toBe('call');
  });

  it('"nhắn tin" → message', () => {
    const r = parseAppointmentFromText('nhắn tin lại sau 9h sáng mai nhé', NOW);
    expect(r).not.toBeNull();
    expect(r!.type).toBe('message');
  });

  it('"cafe" → meeting', () => {
    const r = parseAppointmentFromText('mai đi cafe nhé', NOW);
    expect(r).not.toBeNull();
    expect(r!.type).toBe('meeting');
  });
});

describe('parseAppointmentFromText — matchedPhrase + confidence', () => {
  it('returns trimmed matched phrase', () => {
    const r = parseAppointmentFromText('   9h sáng mai gặp em   ', NOW);
    expect(r).not.toBeNull();
    expect(r!.matchedPhrase).toBe('9h sáng mai gặp em');
  });

  it('confidence is in [0.35, 1]', () => {
    const r = parseAppointmentFromText('hẹn 14:00 ngày 20/5 gặp em', NOW);
    expect(r).not.toBeNull();
    expect(r!.confidence).toBeGreaterThanOrEqual(0.35);
    expect(r!.confidence).toBeLessThanOrEqual(1);
  });
});

describe('parseAppointmentFromText — defaults', () => {
  it('uses default `now` when omitted (smoke test)', () => {
    const r = parseAppointmentFromText('hẹn gặp mai');
    expect(r).not.toBeNull();
    expect(r!.date instanceof Date).toBe(true);
  });
});
