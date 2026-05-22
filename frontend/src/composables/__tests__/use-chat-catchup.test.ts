/**
 * Feature 0050 — `mergeIncomingMessages` pure function.
 *
 * Covers AC-0006: catch-up response is merged dedup by id; messages slot
 * in chronologically. The function is the safety net for the case where
 * a socket-delivered message and a catch-up-delivered message both
 * arrive for the same id.
 */
import { describe, it, expect } from 'vitest';
import { mergeIncomingMessages } from '@/composables/use-chat';
import type { Message } from '@/composables/use-chat';

function msg(id: string, sentAt: string, content = id): Message {
  // Cast to Message — the full Message type carries 20+ fields we don't
  // need for testing the merge logic. The function only touches `id` +
  // `sentAt`, so the partial cast is safe.
  return { id, sentAt, content } as unknown as Message;
}

describe('mergeIncomingMessages', () => {
  it('returns a copy of existing when incoming is empty', () => {
    const existing = [msg('a', '2026-05-22T10:00:00Z')];
    const result = mergeIncomingMessages(existing, []);
    expect(result).toEqual(existing);
    // Defensive copy — caller should not mutate input.
    expect(result).not.toBe(existing);
  });

  it('appends a single new message after existing tail', () => {
    const existing = [
      msg('a', '2026-05-22T10:00:00Z'),
      msg('b', '2026-05-22T10:01:00Z'),
    ];
    const result = mergeIncomingMessages(existing, [msg('c', '2026-05-22T10:02:00Z')]);
    expect(result.map((m) => m.id)).toEqual(['a', 'b', 'c']);
  });

  it('dedupes by id when the socket already delivered the same message', () => {
    // Realistic race: socket pushed `c` while the catch-up was in flight;
    // catch-up returns `c` and `d`. We should only get `d` added.
    const existing = [
      msg('a', '2026-05-22T10:00:00Z'),
      msg('b', '2026-05-22T10:01:00Z'),
      msg('c', '2026-05-22T10:02:00Z'),
    ];
    const result = mergeIncomingMessages(existing, [
      msg('c', '2026-05-22T10:02:00Z'), // dup
      msg('d', '2026-05-22T10:03:00Z'),
    ]);
    expect(result.map((m) => m.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('sorts additions chronologically even if server returns out-of-order', () => {
    const existing = [msg('a', '2026-05-22T10:00:00Z')];
    // Server happens to return newer-first; we should still place them asc.
    const result = mergeIncomingMessages(existing, [
      msg('c', '2026-05-22T10:02:00Z'),
      msg('b', '2026-05-22T10:01:00Z'),
    ]);
    expect(result.map((m) => m.id)).toEqual(['a', 'b', 'c']);
  });

  it('returns a stable copy when all incoming are duplicates', () => {
    const existing = [
      msg('a', '2026-05-22T10:00:00Z'),
      msg('b', '2026-05-22T10:01:00Z'),
    ];
    const result = mergeIncomingMessages(existing, [
      msg('a', '2026-05-22T10:00:00Z'),
      msg('b', '2026-05-22T10:01:00Z'),
    ]);
    expect(result.map((m) => m.id)).toEqual(['a', 'b']);
    expect(result).not.toBe(existing);
  });

  it('handles empty existing + non-empty incoming', () => {
    const result = mergeIncomingMessages([], [
      msg('b', '2026-05-22T10:01:00Z'),
      msg('a', '2026-05-22T10:00:00Z'),
    ]);
    expect(result.map((m) => m.id)).toEqual(['a', 'b']);
  });
});
