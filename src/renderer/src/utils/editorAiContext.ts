// Shared helper used by QueryView and ScriptsView to answer the AI assistant's
// get_editor_content / get_editor_selection tool calls (see 'llm:get-editor-request'
// in the preload API and the runTool branch in src/main/ipc-handlers.ts).

export interface EditorContentResponse {
  content: string
  source: 'query' | 'scripts'
  language: 'sql' | 'javascript'
  truncated: boolean
}

// Keeps tool results reasonably sized, mirroring the row cap already applied to
// the execute_sql tool result in ipc-handlers.ts.
const MAX_EDITOR_CONTENT_CHARS = 50_000

export function buildEditorContentResponse(
  content: string,
  source: 'query' | 'scripts',
  language: 'sql' | 'javascript'
): EditorContentResponse {
  if (content.length > MAX_EDITOR_CONTENT_CHARS) {
    return { content: content.slice(0, MAX_EDITOR_CONTENT_CHARS), source, language, truncated: true }
  }
  return { content, source, language, truncated: false }
}

// ── Inline selection context (embedded directly in the outgoing user message) ──
// Small selections are sent inline with every chat message so the assistant can
// see them without needing a get_editor_selection tool round trip. This is kept
// out of the system prompt (which is meant to stay byte-for-byte stable across
// turns for provider-side prompt caching) and instead prepended to the user
// message content built in AiChatPanel.vue's sendMessage().

export interface EditorSelectionSnapshot {
  content: string
  source: 'query' | 'scripts'
  language: 'sql' | 'javascript'
}

// ~2 KB — above this, only the fact that a selection exists is mentioned, and the
// assistant is told to call get_editor_selection itself if it actually needs it.
export const MAX_INLINE_SELECTION_CHARS = 2048

/**
 * Builds the `<user_selection>` context block prepended to every outgoing chat
 * message. Always emits a block — even when there is no selection — so the
 * assistant never has to guess whether one exists (see the "Editor Context
 * Tools" section of the system prompt in src/main/llm.ts for how it's used).
 */
export function buildSelectionContextBlock(selection: EditorSelectionSnapshot | null): string {
  if (!selection || !selection.content) {
    return '<user_selection status="none" />'
  }
  if (selection.content.length > MAX_INLINE_SELECTION_CHARS) {
    return (
      `<user_selection status="too_large" source="${selection.source}" language="${selection.language}" length="${selection.content.length}">\n` +
      `The user has a selection in the ${selection.source === 'query' ? 'Query Editor' : 'Script Editor'}, but it is ${selection.content.length} characters — too large to include inline. ` +
      'Call the get_editor_selection tool if you actually need its contents.\n' +
      '</user_selection>'
    )
  }
  return (
    `<user_selection status="present" source="${selection.source}" language="${selection.language}">\n` +
    `${selection.content}\n` +
    '</user_selection>\n' +
    '(Only use the selection above if it is relevant to the message below.)'
  )
}
