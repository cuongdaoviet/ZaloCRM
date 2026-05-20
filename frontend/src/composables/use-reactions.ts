/**
 * use-reactions — feature 0021 client logic.
 *
 * Exposes optimistic add/toggle/remove for message reactions, plus a
 * Socket.IO subscriber that merges live `chat:reaction` events into a
 * caller-supplied `messages` ref.
 *
 * Optimism model (UX-critical so the chip flips instantly):
 *  - On user click, we mutate `messages.value[i].reactions` immediately
 *    using a synthesized row (uuid-less optimistic stub).
 *  - We then POST. On 2xx, the real server row replaces the stub. On 4xx/5xx
 *    or network error, we restore the pre-click state.
 *
 * The composable is intentionally caller-driven: it doesn't OWN the
 * messages list — it accepts a ref + the current user id. This keeps it
 * compatible with the chat composable's existing ref ownership.
 */
import { ref, type Ref } from 'vue';
import type { Socket } from 'socket.io-client';
import { api } from '@/api/index';

export interface MessageReaction {
  id: string;
  reactorId: string;
  reactorSource: string; // 'crm' | 'zalo'
  reactorName: string | null;
  emoji: string;
  createdAt: string;
}

export interface MessageWithReactions {
  id: string;
  reactions?: MessageReaction[];
}

export interface ChatReactionSocketPayload {
  accountId: string;
  conversationId: string;
  messageId: string;
  reaction: MessageReaction | null;
  removed?: { reactorSource: string; reactorId: string };
}

/** The 6 standard emojis exposed in the UI picker (must match BE BR-0014). */
export const STANDARD_EMOJIS = ['❤️', '👍', '😆', '😮', '😭', '😡'] as const;
export type StandardEmoji = (typeof STANDARD_EMOJIS)[number];

/**
 * Build a stable visual grouping for chip rendering. Dedupes self-listen
 * race rows by `(reactorSource, reactorId)` first — for a single rep that
 * holds both a `crm` and a `zalo` row (same Zalo account), we collapse to
 * one count. See SPEC EC-0004.
 *
 * The dedupe key for a "person" is:
 *   - For CRM-side rows: `crm:<reactorId>` (CRM user.id)
 *   - For Zalo-side rows: `zalo:<reactorId>` (Zalo UID)
 *
 * Note: we can't safely collapse "the CRM user is also the Zalo account
 * owner" purely from row data — the caller-supplied `zaloAccountUid` lets
 * us pair them up. Pass null to skip pairing (still correct, just shows
 * "2" instead of "1" if both sides emitted).
 */
export function groupReactionsForDisplay(
  reactions: MessageReaction[],
  selfUserId: string | null,
  zaloAccountUid: string | null,
): Array<{ emoji: string; count: number; mine: boolean }> {
  const seenPeople = new Set<string>();
  const buckets = new Map<string, { count: number; mine: boolean }>();
  for (const r of reactions) {
    const personKey = personKeyFor(r, zaloAccountUid);
    if (seenPeople.has(personKey)) continue;
    seenPeople.add(personKey);
    const bucket = buckets.get(r.emoji) ?? { count: 0, mine: false };
    bucket.count += 1;
    if (selfUserId && isMine(r, selfUserId, zaloAccountUid)) bucket.mine = true;
    buckets.set(r.emoji, bucket);
  }
  return Array.from(buckets.entries()).map(([emoji, b]) => ({ emoji, ...b }));
}

function personKeyFor(r: MessageReaction, zaloAccountUid: string | null): string {
  // If the row is the Zalo-side mirror of "me" (the rep's own self-listen),
  // collapse it to the CRM person key so dedupe wins.
  if (zaloAccountUid && r.reactorSource === 'zalo' && r.reactorId === zaloAccountUid) {
    return `self`;
  }
  return `${r.reactorSource}:${r.reactorId}`;
}

function isMine(r: MessageReaction, selfUserId: string, zaloAccountUid: string | null): boolean {
  if (r.reactorSource === 'crm' && r.reactorId === selfUserId) return true;
  if (zaloAccountUid && r.reactorSource === 'zalo' && r.reactorId === zaloAccountUid) return true;
  return false;
}

export function useReactions(opts: {
  messages: Ref<MessageWithReactions[]>;
  selfUserId: Ref<string | null>;
  selfFullName: Ref<string | null>;
}) {
  const pending = ref(new Set<string>());

  function findMessage(messageId: string): MessageWithReactions | null {
    return opts.messages.value.find((m) => m.id === messageId) ?? null;
  }

  function ensureReactionsArray(msg: MessageWithReactions): MessageReaction[] {
    if (!msg.reactions) msg.reactions = [];
    return msg.reactions;
  }

  /**
   * Optimistic add / toggle. Flips local state immediately, calls POST, and
   * rolls back on failure. Concurrent clicks on the same (messageId,
   * selfUserId) are coalesced via the `pending` set.
   */
  async function addOrToggle(messageId: string, emoji: string): Promise<void> {
    if (!STANDARD_EMOJIS.includes(emoji as StandardEmoji)) return;
    if (!opts.selfUserId.value) return;
    const key = `${messageId}:${opts.selfUserId.value}`;
    if (pending.value.has(key)) return;
    pending.value.add(key);

    const msg = findMessage(messageId);
    if (!msg) {
      pending.value.delete(key);
      return;
    }
    const list = ensureReactionsArray(msg);
    const before = [...list];
    const myExisting = list.find(
      (r) => r.reactorSource === 'crm' && r.reactorId === opts.selfUserId.value,
    );

    // Apply optimistic mutation
    if (myExisting && myExisting.emoji === emoji) {
      // Toggle off
      const idx = list.indexOf(myExisting);
      list.splice(idx, 1);
    } else if (myExisting) {
      myExisting.emoji = emoji;
    } else {
      list.push({
        id: `optimistic-${Date.now()}`,
        reactorId: opts.selfUserId.value!,
        reactorSource: 'crm',
        reactorName: opts.selfFullName.value,
        emoji,
        createdAt: new Date().toISOString(),
      });
    }

    try {
      const res = await api.post(`/messages/${messageId}/reactions`, { emoji });
      if (res.status === 200 && res.data?.toggledOff) {
        // server agrees → nothing to do (we already removed locally).
        return;
      }
      // 201 — replace optimistic stub with the real row (matching reactorId).
      const real: MessageReaction = res.data;
      const idx = list.findIndex(
        (r) => r.reactorSource === 'crm' && r.reactorId === opts.selfUserId.value,
      );
      if (idx >= 0) list.splice(idx, 1, real);
      else list.push(real);
    } catch (err) {
      // Rollback on any error
      msg.reactions = before;
      console.warn('[reactions] add/toggle failed, rolled back:', err);
    } finally {
      pending.value.delete(key);
    }
  }

  /** Explicit DELETE — used when caller wants to drop the reaction without picker. */
  async function remove(messageId: string): Promise<void> {
    if (!opts.selfUserId.value) return;
    const msg = findMessage(messageId);
    if (!msg) return;
    const list = ensureReactionsArray(msg);
    const before = [...list];
    msg.reactions = list.filter(
      (r) => !(r.reactorSource === 'crm' && r.reactorId === opts.selfUserId.value),
    );
    try {
      await api.delete(`/messages/${messageId}/reactions`);
    } catch (err) {
      msg.reactions = before;
      console.warn('[reactions] remove failed, rolled back:', err);
    }
  }

  /** Wire up `chat:reaction` subscription on an existing socket. */
  function subscribe(socket: Socket): void {
    socket.on('chat:reaction', (data: ChatReactionSocketPayload) => {
      const msg = findMessage(data.messageId);
      if (!msg) return;
      const list = ensureReactionsArray(msg);
      if (data.reaction) {
        // Upsert by (reactorSource, reactorId)
        const idx = list.findIndex(
          (r) =>
            r.reactorSource === data.reaction!.reactorSource &&
            r.reactorId === data.reaction!.reactorId,
        );
        if (idx >= 0) list.splice(idx, 1, data.reaction);
        else list.push(data.reaction);
      } else if (data.removed) {
        const idx = list.findIndex(
          (r) =>
            r.reactorSource === data.removed!.reactorSource &&
            r.reactorId === data.removed!.reactorId,
        );
        if (idx >= 0) list.splice(idx, 1);
      }
    });
  }

  return {
    addOrToggle,
    remove,
    subscribe,
    pending,
  };
}
