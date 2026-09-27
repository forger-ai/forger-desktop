/** Only for the synthetic protocol probe; never collect real user prompt/context here. */
export function createProbeDiagnostics({ maxChars = 32768 } = {}) {
  let stdout = '';
  let stderr = '';
  let truncated = false;
  const secrets = new Set();
  const toolOutputs = [];
  const redact = (text) => {
    for (const secret of secrets) text = text.split(secret).join('[REDACTED]');
    return text.replace(/sk-[A-Za-z0-9_-]{12,}/g, '[REDACTED]');
  };
  return {
    addSecret: (secret) => { if (typeof secret === 'string' && secret.length) secrets.add(secret); },
    addOutput: (stream, text) => {
      if (stream === 'stdout') { truncated ||= stdout.length + text.length > maxChars; stdout = (stdout + text).slice(-maxChars); }
      else if (stream === 'stderr') { truncated ||= stderr.length + text.length > maxChars; stderr = (stderr + text).slice(-maxChars); }
    },
    addToolOutputs: (input) => {
      if (!Array.isArray(input)) return;
      for (const item of input) {
        if (!item || !['function_call_output', 'custom_tool_call_output'].includes(item.type)) continue;
        const serialized = typeof item.output === 'string' ? item.output : JSON.stringify(item.output);
        toolOutputs.push({ type: item.type, call_id: item.call_id, output: typeof serialized === 'string' ? serialized.slice(0, maxChars) : null });
        if (serialized?.length > maxChars) truncated = true;
        if (toolOutputs.length > 8) { toolOutputs.shift(); truncated = true; }
      }
    },
    snapshot: () => {
      let unparsedStdoutLines = 0;
      const events = stdout.split('\n').filter((line) => line.trim()).flatMap((line) => {
        try { return [JSON.parse(line)]; } catch { unparsedStdoutLines++; return []; }
      });
      return JSON.parse(redact(JSON.stringify({ events, stderr, toolOutputs, unparsedStdoutLines, truncated })));
    },
  };
}
