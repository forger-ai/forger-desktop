export const parseCodexTaskJsonl = (stdout: string, stderr: string): string => {
  const raw = stdout.trim() || stderr.trim();
  let assistantText = '';
  for (const line of raw.split('\n').map((entry) => entry.trim()).filter(Boolean)) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed.type === 'item.completed' && parsed.item && typeof parsed.item === 'object') {
        const item = parsed.item as Record<string, unknown>;
        if (item.type === 'agent_message' && typeof item.text === 'string') {
          assistantText = item.text.trim();
        }
      }
    } catch {
      assistantText = assistantText ? `${assistantText}\n${line}` : line;
    }
  }
  return assistantText.trim();
};

export const parseClaudeTaskJsonl = (stdout: string, stderr: string): string => {
  const raw = stdout.trim() || stderr.trim();
  let assistantText = '';
  for (const line of raw.split('\n').map((entry) => entry.trim()).filter(Boolean)) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (typeof parsed.result === 'string') {
        assistantText = parsed.result.trim();
        continue;
      }
      const text = extractClaudeText(parsed);
      if (text) {
        assistantText = text.trim();
      }
    } catch {
      assistantText = assistantText ? `${assistantText}\n${line}` : line;
    }
  }
  return assistantText.trim();
};

export const parseCodexConversationJsonl = (stdout: string, stderr: string): { assistantText: string; threadId?: string } => {
  const raw = stdout.trim() || stderr.trim();
  let assistantText = '';
  let threadId: string | undefined;
  for (const line of raw.split('\n').map((entry) => entry.trim()).filter(Boolean)) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed.type === 'thread.started' && typeof parsed.thread_id === 'string') {
        threadId = parsed.thread_id;
      }
      if (parsed.type === 'item.completed' && parsed.item && typeof parsed.item === 'object') {
        const item = parsed.item as Record<string, unknown>;
        if (item.type === 'agent_message' && typeof item.text === 'string') {
          assistantText = item.text.trim();
        }
      }
    } catch {
      assistantText = assistantText ? `${assistantText}\n${line}` : line;
    }
  }
  return { assistantText: assistantText.trim(), threadId };
};

export const parseClaudeConversationJsonl = (stdout: string, stderr: string): { assistantText: string; threadId?: string } => {
  const raw = stdout.trim() || stderr.trim();
  let assistantText = '';
  let threadId: string | undefined;
  for (const line of raw.split('\n').map((entry) => entry.trim()).filter(Boolean)) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (!threadId) {
        const sessionId = parsed.session_id ?? parsed.sessionId ?? parsed.conversation_id;
        if (typeof sessionId === 'string' && sessionId.trim()) {
          threadId = sessionId.trim();
        }
      }
      if (typeof parsed.result === 'string') {
        assistantText = parsed.result.trim();
        continue;
      }
      const text = extractClaudeText(parsed);
      if (text) {
        assistantText = text.trim();
      }
    } catch {
      assistantText = assistantText ? `${assistantText}\n${line}` : line;
    }
  }
  return { assistantText: assistantText.trim(), threadId };
};

const extractClaudeText = (entry: Record<string, unknown>): string => {
  if (typeof entry.text === 'string') {
    return entry.text;
  }
  const message = entry.message;
  if (!message || typeof message !== 'object') {
    return '';
  }
  const content = (message as Record<string, unknown>).content;
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map((item) => {
      if (!item || typeof item !== 'object') {
        return '';
      }
      const text = (item as Record<string, unknown>).text;
      return typeof text === 'string' ? text : '';
    })
    .filter(Boolean)
    .join('\n');
};
