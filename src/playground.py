"""Minimal browser playground served at ``GET /``."""

from __future__ import annotations

_PAGE = """<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Translation Playground</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
         margin: 0; padding: 2rem 1rem; background: Canvas; color: CanvasText; }
  main { max-width: 880px; margin: 0 auto; display: grid; gap: 1rem; }
  h1 { font-size: 1.25rem; margin: 0; }
  .row { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: .75rem; }
  label { display: grid; gap: .35rem; font-size: .8rem; opacity: .8; }
  textarea, input, select, button { font: inherit; padding: .6rem .7rem; border-radius: .5rem;
         border: 1px solid color-mix(in oklch, CanvasText 22%, transparent); background: Canvas; color: CanvasText; }
  textarea { min-height: 160px; resize: vertical; }
  button { cursor: pointer; background: color-mix(in oklch, CanvasText 8%, transparent); font-weight: 600; }
  button:disabled { opacity: .5; cursor: progress; }
  pre { white-space: pre-wrap; word-break: break-word; margin: 0; padding: .9rem;
        border-radius: .5rem; background: color-mix(in oklch, CanvasText 6%, transparent); }
  .meta { font-size: .78rem; opacity: .7; display: flex; gap: 1rem; flex-wrap: wrap; }
  .error { color: #d33; }
</style>
</head>
<body>
<main>
  <h1>翻译服务 · Workers AI + AI Gateway</h1>
  <label>原文<textarea id="text" placeholder="输入要翻译的内容…"></textarea></label>
  <div class="row">
    <label>目标语言<input id="target" value="zh-CN" /></label>
    <label>源语言<input id="source" value="auto" /></label>
    <label>语气（可选）<input id="tone" placeholder="formal / casual" /></label>
    <label>API Token（可选）<input id="token" type="password" placeholder="Authorization: Bearer" /></label>
  </div>
  <button id="run">翻译</button>
  <div class="meta" id="meta"></div>
  <pre id="out" class="error" hidden></pre>
</main>
<script>
const run = document.getElementById('run');
const out = document.getElementById('out');
const meta = document.getElementById('meta');

run.addEventListener('click', async () => {
  const text = document.getElementById('text').value.trim();
  if (!text) { return; }
  const token = document.getElementById('token').value.trim();
  const headers = { 'content-type': 'application/json' };
  if (token) { headers.authorization = `Bearer ${token}`; }

  run.disabled = true;
  meta.textContent = '';
  out.hidden = true;
  try {
    const response = await fetch('/translate', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        text,
        target_lang: document.getElementById('target').value.trim() || 'zh-CN',
        source_lang: document.getElementById('source').value.trim() || 'auto',
        tone: document.getElementById('tone').value.trim() || undefined,
      }),
    });
    const data = await response.json();
    out.hidden = false;
    if (!response.ok) {
      out.className = 'error';
      out.textContent = `${data.error?.code ?? 'error'}: ${data.error?.message ?? response.status}`;
      meta.textContent = `request_id ${data.request_id ?? '-'}`;
      return;
    }
    out.className = '';
    out.textContent = data.translation;
    meta.textContent = [
      `request_id ${data.request_id}`,
      `model ${data.meta.model}`,
      `gateway ${data.meta.gateway}`,
      `chunks ${data.meta.chunks}`,
      `tokens ${data.meta.tokens.total}`,
      `${data.meta.duration_ms} ms`,
    ].join(' · ');
  } catch (error) {
    out.hidden = false;
    out.className = 'error';
    out.textContent = String(error);
  } finally {
    run.disabled = false;
  }
});
</script>
</body>
</html>
"""


def render_playground() -> str:
    return _PAGE
