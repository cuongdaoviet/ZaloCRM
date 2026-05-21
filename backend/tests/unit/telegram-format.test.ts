/**
 * Unit tests for the Telegram message formatter — Feature 0038 BR-0013.
 */
import { describe, it, expect } from 'vitest';
import { formatEventMessage } from '../../src/modules/integrations/connectors/telegram-bot.js';

describe('formatEventMessage', () => {
  it('formats contact.created per BR-0013', () => {
    const msg = formatEventMessage({
      orgId: 'o',
      type: 'contact.created',
      payload: { fullName: 'Trần B', phone: '0901', source: 'web' },
      emittedAt: new Date(),
    });
    expect(msg).toBe('🆕 KH mới: Trần B (0901) — nguồn: web');
  });

  it('formats order.created with localized amount', () => {
    const msg = formatEventMessage({
      orgId: 'o',
      type: 'order.created',
      payload: { orderNumber: 'ORD-001', amount: 1500000, fullName: 'Nguyễn C' },
      emittedAt: new Date(),
    });
    expect(msg).toContain('ORD-001');
    expect(msg).toContain('Nguyễn C');
    expect(msg).toContain('1.500.000');
  });

  it('formats appointment.reminder', () => {
    const msg = formatEventMessage({
      orgId: 'o',
      type: 'appointment.reminder',
      payload: { contactName: 'Phạm D', time: '14:30' },
      emittedAt: new Date(),
    });
    expect(msg).toContain('Phạm D');
    expect(msg).toContain('14:30');
  });

  it('formats message.escalated', () => {
    const msg = formatEventMessage({
      orgId: 'o',
      type: 'message.escalated',
      payload: { contactName: 'Hoàng E', reason: 'không trả lời 30p' },
      emittedAt: new Date(),
    });
    expect(msg).toContain('Hoàng E');
    expect(msg).toContain('không trả lời');
  });

  it('falls back gracefully for unknown event types', () => {
    const msg = formatEventMessage({
      orgId: 'o',
      type: 'custom.event' as any,
      payload: { foo: 'bar' },
      emittedAt: new Date(),
    });
    expect(msg).toContain('custom.event');
    expect(msg).toContain('foo');
  });
});
