/**
 * Shared message-preview formatter.
 *
 * Zalo delivers some message types as JSON-stringified payloads (reminders,
 * banking cards, group info shares, link cards, etc.). Rendering the raw
 * content as plain text leaks `{"title":"..."}` into the UI which looks
 * broken. ConversationList has handled this for its row previews since
 * Feature 0049 F5; this helper extracts that logic so search dropdowns
 * (GlobalSearch) and the message-search results page (MessageSearchView)
 * get the same treatment.
 *
 * Pure function — no Vue refs, no side effects. Easy to unit-test.
 */

export interface MessagePreviewOptions {
  /** Max characters of body text before truncation. Default 60. */
  maxChars?: number;
  /** What to display when an attachment / structured payload has no
   *  extractable label. Default '[Tin nhắn dạng đặc biệt]'. */
  fallbackLabel?: string;
}

/** Map known content types to their human-readable single-line preview.
 *  Returns null when the content type is plain text (caller should render
 *  `content` directly through the JSON-parser path below). */
function attachmentPreview(contentType: string | null | undefined): string | null {
  switch (contentType) {
    case 'image': return '📷 Hình ảnh';
    case 'sticker': return '🏷️ Sticker';
    case 'video': return '🎥 Video';
    case 'voice': return '🎤 Tin nhắn thoại';
    case 'gif': return 'GIF';
    case 'file': return '📎 Tệp đính kèm';
    case 'link': return '🔗 Liên kết';
    default: return null;
  }
}

/** Try to pull a human-readable label out of a JSON-stringified payload.
 *  Returns the extracted label, or `''` if no usable field was found, or
 *  `null` if the content wasn't JSON at all. */
function extractJsonLabel(content: string): string | null {
  if (!content || !content.trimStart().startsWith('{')) return null;
  try {
    const p = JSON.parse(content) as Record<string, unknown>;
    // Specific case first: Zalo reminder/calendar messages
    if (p?.action === 'msginfo.actionlist' && typeof p?.title === 'string') {
      return '📅 ' + p.title;
    }
    // Generic fallback — try common label fields in descending richness.
    if (typeof p?.title === 'string' && p.title) return p.title;
    if (typeof p?.text === 'string' && p.text) return p.text;
    if (typeof p?.description === 'string' && p.description) return p.description;
    if (typeof p?.name === 'string' && p.name) return p.name;
    return '';
  } catch {
    return null;
  }
}

/**
 * Format any message content into a single-line preview safe for a list
 * row, search result, or notification snippet.
 *
 * @param content   The raw message content (may be plain text, may be JSON-stringified payload, may be null)
 * @param contentType  Optional content-type hint ('image', 'sticker', etc.). When provided and recognized, takes precedence over content parsing.
 * @param opts      Optional max-chars / fallback-label overrides.
 */
export function formatMessagePreview(
  content: string | null | undefined,
  contentType?: string | null,
  opts: MessagePreviewOptions = {},
): string {
  const maxChars = opts.maxChars ?? 60;
  const fallbackLabel = opts.fallbackLabel ?? '[Tin nhắn dạng đặc biệt]';

  // Attachment types short-circuit — content is metadata, not text to render.
  const attachment = attachmentPreview(contentType);
  if (attachment) return attachment;

  if (!content) return '';

  // JSON-payload path. If parsing succeeds:
  //   - non-empty label → use it (clipped below)
  //   - empty label → use the configurable fallback (e.g. "[Tin nhắn dạng đặc biệt]")
  // If parsing fails (content starts with `{` but isn't JSON) we fall
  // through to plain-text rendering.
  const jsonLabel = extractJsonLabel(content);
  if (jsonLabel !== null) {
    const label = jsonLabel || fallbackLabel;
    return label.length > maxChars ? label.slice(0, maxChars) + '...' : label;
  }

  // Plain text path.
  return content.length > maxChars ? content.slice(0, maxChars) + '...' : content;
}
