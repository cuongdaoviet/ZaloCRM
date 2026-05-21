/**
 * Defense-in-depth for prompt injection: strip the literal
 * <conversation_context> tags from any user-supplied text we splice into
 * the prompt template. Ported verbatim from ZaloCRM-3.0
 * (`backend/src/modules/ai/ai-service.ts:escapeXmlBoundary`).
 *
 * This is a CHEAP layer on top of the system-prompt instruction that tells
 * the model to "use only text inside <conversation_context>". An attacker who
 * sneaks `</conversation_context>` into a message tries to break out of the
 * sandbox; we just strip it.
 *
 * NOTE: This is NOT a full HTML/XML escape — message bodies in chat are
 * plain text. We only neutralise the boundary tag.
 */
export function escapeXmlBoundary(text: string): string {
  return text.replace(/<\/?conversation_context>/gi, '');
}
