// The Gmail tools' answers in a ChatGPT/Codex cloud run, in the shapes captured from a live run on 2026-11-20
// (redacted: the shapes are exact, the values made up, addresses .example only). The tools are
// mcp__codex_apps__gmail_search_emails and mcp__codex_apps__gmail_send_email; each answers an MCP CallToolResult, and the
// cloud model writes JSON.stringify(result) to the answer file, the whole result with structuredContent inside.

// One email in a search result, as the tool lists it.
export function email({ id = '1a1fa46de5461f6f', thread_id = id, from_, to = ['Sam Lane <sam@lanecraft.example>'], subject = 'Re: At Harbor Expo', snippet = 'Tuesday works', labels = ['UNREAD', 'CATEGORY_PERSONAL', 'INBOX'], email_ts = '2026-10-13T10:45:10-07:00' } = {}) {
  return {
    id,
    thread_id,
    from_,
    to,
    cc: [],
    bcc: [],
    subject,
    snippet,
    labels,
    has_attachment: false,
    attachments: [],
    inline_images: [],
    email_ts,
    display_url: `https://mail.google.com/mail/u/0/#all/${id}`,
    display_title: subject
  };
}

// The search tool's whole result.
export const searchResult = (emails = [], { next_page_token = null, isError = false } = {}) => ({
  content: [{ type: 'text', text: 'Action completed.' }],
  structuredContent: { emails, next_page_token },
  isError
});

// The send tool's whole result, with the response_fields asked for (id, thread_id) in structuredContent.
export const sendResult = (structuredContent = { id: '19a2b3c4d5e6f708', thread_id: '19a2b3c4d5e6f708' }, { isError = false, text = 'Action completed.' } = {}) => ({
  content: [{ type: 'text', text }],
  structuredContent,
  isError
});

// What the cloud model writes to the answer file.
export const written = (result) => JSON.stringify(result);

// The profile tool's whole result (mcp__codex_apps__gmail_get_profile, called with {}): the connected account.
export const profileResult = (fields = {}, { isError = false } = {}) => ({
  content: [{ type: 'text', text: 'Action completed.' }],
  structuredContent: { id: 'u1', name: 'Sam Lane', email: 'sam@lanecraft.example', nickname: 'sam', picture: null, workspace_id: 'w1', workspace_name: 'Lanecraft', workspace_picture: null, ...fields },
  isError
});

// The thread tool's whole result (mcp__codex_apps__gmail_read_email_thread). Its shape wasn't captured yet: assumed
// to hold the thread's messages in the search's item shape, under messages.
export const threadResult = (messages = [], { isError = false } = {}) => ({
  content: [{ type: 'text', text: 'Action completed.' }],
  structuredContent: { messages },
  isError
});
