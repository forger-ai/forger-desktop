import type http from 'node:http';

export type OAuthCallbackPageKind = 'success' | 'error' | 'idle';

const escapeHtml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export const sendOAuthCallbackPage = (
  response: http.ServerResponse,
  statusCode: number,
  kind: OAuthCallbackPageKind,
  title: string,
  body: string,
): void => {
  const ok = kind === 'success';
  const mark = ok ? 'OK' : kind === 'error' ? '!' : '...';
  response.writeHead(statusCode, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(`<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title><style>
:root{color-scheme:dark;--bg:#101418;--panel:#161b21;--line:#2a323c;--text:#f3f5f7;--muted:#aab2bd;--ok:#8bd39b;--bad:#ff8a8a}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:32px;background:var(--bg);color:var(--text);font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{width:min(520px,100%);border:1px solid var(--line);border-radius:12px;background:var(--panel);padding:28px;box-shadow:0 24px 80px rgba(0,0,0,.32)}
.brand{display:flex;align-items:center;gap:10px;margin-bottom:24px;color:var(--muted);font-weight:700}
.logo{width:30px;height:30px;border-radius:8px;display:grid;place-items:center;background:#f4f4f2;color:#101418;font-weight:900}
.status{width:42px;height:42px;border-radius:50%;display:grid;place-items:center;margin-bottom:16px;background:${ok ? 'rgba(139,211,155,.16)' : 'rgba(255,138,138,.16)'};color:${ok ? 'var(--ok)' : 'var(--bad)'};font-weight:800}
h1{margin:0 0 10px;font-size:clamp(28px,4vw,40px);line-height:1.05;letter-spacing:0}p{margin:0;color:var(--muted);font-size:17px;line-height:1.5}
</style></head><body><main><div class="brand"><div class="logo">F</div><span>Forger</span></div>
<div class="status">${mark}</div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p></main></body></html>`);
};
