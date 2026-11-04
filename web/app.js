const KEY_STORAGE = "nt.api_key";
const LANGS = [
  ["zh-CN", "简体中文"],
  ["zh-TW", "繁體中文"],
  ["en", "English"],
  ["ja", "日本語"],
  ["ko", "한국어"],
  ["fr", "Français"],
  ["de", "Deutsch"],
  ["es", "Español"],
  ["ru", "Русский"],
  ["pt", "Português"],
  ["it", "Italiano"],
  ["ar", "العربية"],
  ["hi", "हिन्दी"],
  ["th", "ไทย"],
  ["vi", "Tiếng Việt"],
  ["id", "Indonesia"],
];

const state = {
  key: localStorage.getItem(KEY_STORAGE) || "",
  session: null,
  models: null,
  stats: null,
  statsError: null,
  statsLoading: false,
  setupTab: "plugin",
  draft: { text: "", target: "zh-CN", source: "auto", tone: "", model: "" },
  translate: { busy: false, result: null, error: null },
};

const app = document.getElementById("app");
const toastEl = document.getElementById("toast");

/* ---------- helpers ---------- */

const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch],
  );

const fmt = (value, digits = 1) =>
  Number(value ?? 0).toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  });

let toastTimer;
function toast(message, bad = false) {
  toastEl.textContent = message;
  toastEl.className = `toast show${bad ? " bad" : ""}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.className = "toast";
  }, 2400);
}

async function copy(text, label = "已复制") {
  try {
    await navigator.clipboard.writeText(text);
    toast(label);
  } catch {
    toast("复制失败，请手动选择", true);
  }
}

async function api(path, { method = "GET", body } = {}) {
  const headers = { "content-type": "application/json" };
  if (state.key) headers.authorization = `Bearer ${state.key}`;
  const response = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (response.status === 401) {
    logout("密钥已失效，请重新登录");
    throw new Error("unauthorized");
  }
  if (!response.ok) {
    const message =
      (payload && (payload.error?.message || payload.message)) || `HTTP ${response.status}`;
    throw new Error(message);
  }
  return payload;
}

/* ---------- session ---------- */

function logout(message) {
  localStorage.removeItem(KEY_STORAGE);
  state.key = "";
  state.session = null;
  state.stats = null;
  render();
  if (message) toast(message, true);
}

async function login(key) {
  const trimmed = key.trim();
  if (!trimmed) {
    renderLogin("请输入 API Key");
    return;
  }
  state.key = trimmed;
  try {
    const session = await api("/api/verify");
    localStorage.setItem(KEY_STORAGE, trimmed);
    state.session = session;
    state.stats = null;
    state.models = null;
    loadModels();
    navigate("/stats");
    toast("登录成功");
  } catch (error) {
    state.key = "";
    renderLogin(error.message === "unauthorized" ? "API Key 不正确" : error.message);
  }
}

/* ---------- router ---------- */

function currentPath() {
  const hash = location.hash.replace(/^#/, "");
  return ["/stats", "/translate", "/setup"].includes(hash) ? hash : "/stats";
}

function navigate(path) {
  if (location.hash !== `#${path}`) {
    location.hash = path;
    return;
  }
  render();
}

window.addEventListener("hashchange", () => {
  if (state.session) render();
});

async function bootstrap() {
  if (!state.key) {
    renderLogin();
    return;
  }
  try {
    state.session = await api("/api/verify");
    loadModels();
    render();
  } catch (error) {
    state.key = "";
    localStorage.removeItem(KEY_STORAGE);
    renderLogin(error.message === "unauthorized" ? "密钥已失效，请重新输入" : error.message);
  }
}

window.addEventListener("DOMContentLoaded", bootstrap);

function render() {
  if (!state.session) {
    renderLogin();
    return;
  }
  const path = currentPath();
  const views = { "/stats": renderStats, "/translate": renderTranslate, "/setup": renderSetup };
  renderShell(path, views[path]());
  hydrate();
}

function hydrate() {
  const out = document.getElementById("out");
  if (out && state.translate.result) out.textContent = state.translate.result.text;
  updateCounter();
}

function updateCounter() {
  const counter = document.getElementById("counter");
  const src = document.getElementById("src");
  if (!counter || !src) return;
  const maxChars = state.session?.limits?.max_text_chars ?? 20000;
  const length = src.value.length;
  counter.textContent = `${length} / ${maxChars}`;
  counter.classList.toggle("warn", length > maxChars);
  const button = document.getElementById("run-translate");
  if (button && length > maxChars) button.disabled = true;
}

/* ---------- login ---------- */

function renderLogin(error) {
  app.innerHTML = `
    <section class="login">
      <div class="login-card">
        <div class="brand">
          <div class="brand-mark">N</div>
          <div>
            <div class="brand-name">neuron-translate</div>
            <div class="brand-sub">Workers AI · AI Gateway</div>
          </div>
        </div>
        <h1>用一句 Key<br />唤醒边缘翻译</h1>
        <p class="lede">
          翻译请求跑在 Cloudflare 边缘节点上，经过 AI Gateway 记录、缓存与限流。
          输入你的 API Key 即可进入控制台。
        </p>
        ${error ? `<p class="login-error">${esc(error)}</p>` : ""}
        <form id="login-form">
          <label class="field">
            <span>API Key</span>
            <div class="input-wrap">
              <input id="key-input" type="password" placeholder="sk-trans-…" autocomplete="off" spellcheck="false" />
              <button class="ghost-btn" type="button" id="toggle-key">显示</button>
            </div>
          </label>
          <button class="btn" type="submit" id="login-btn">进入控制台 →</button>
        </form>
        <p class="hint">
          密钥只保存在当前浏览器的 <b>localStorage</b>，不会上传到任何第三方。<br />
          按 <kbd>Enter</kbd> 直接登录
        </p>
      </div>
    </section>
  `;

  const input = document.getElementById("key-input");
  const toggle = document.getElementById("toggle-key");
  const button = document.getElementById("login-btn");

  toggle.addEventListener("click", () => {
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    toggle.textContent = show ? "隐藏" : "显示";
  });

  document.getElementById("login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    button.disabled = true;
    button.textContent = "验证中…";
    await login(input.value);
    button.disabled = false;
    button.textContent = "进入控制台 →";
  });

  setTimeout(() => input.focus(), 80);
}

/* ---------- shell ---------- */

function renderShell(path, content) {
  const nav = [
    ["/stats", "用量"],
    ["/translate", "翻译"],
    ["/setup", "接入"],
  ]
    .map(
      ([href, label]) =>
        `<a href="#${href}" class="${path === href ? "active" : ""}">${label}</a>`,
    )
    .join("");

  app.innerHTML = `
    <div class="shell">
      <header class="topbar">
        <div class="brand">
          <div class="brand-mark">N</div>
          <div>
            <div class="brand-name">neuron-translate</div>
            <div class="brand-sub">${esc(state.session?.model ?? "")}</div>
          </div>
        </div>
        <nav class="nav">${nav}</nav>
        <button class="btn secondary" id="logout-btn">退出</button>
      </header>
      <div class="layout">${content}</div>
      <p class="footer">
        gateway <b>${esc(state.session?.gateway ?? "-")}</b> · workers AI on the edge ·
        <a href="https://github.com/Sube-py/neuron-translate" target="_blank" rel="noreferrer">source</a>
      </p>
    </div>
  `;

  document.getElementById("logout-btn").addEventListener("click", () => logout());
}

async function loadModels() {
  if (state.models) return;
  try {
    const payload = await api("/api/models");
    state.models = payload.data ?? [];
    if (currentPath() === "/translate") render();
  } catch {
    state.models = [];
  }
}

/* ---------- stats ---------- */

function ringMarkup(percent) {
  const radius = 70;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.max(0, Math.min(percent, 100));
  const offset = circumference * (1 - clamped / 100);
  return `
    <div class="ring">
      <svg width="188" height="188" viewBox="0 0 168 168">
        <defs>
          <linearGradient id="ringGradient" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stop-color="#7c5cff" />
            <stop offset="0.6" stop-color="#22d3ee" />
            <stop offset="1" stop-color="#f472b6" />
          </linearGradient>
        </defs>
        <circle class="ring-track" cx="84" cy="84" r="${radius}" />
        <circle
          class="ring-value"
          cx="84"
          cy="84"
          r="${radius}"
          stroke-dasharray="${circumference}"
          stroke-dashoffset="${offset}"
        />
      </svg>
      <div class="ring-label">
        <strong>${fmt(clamped, 2)}%</strong>
        <span>今日已用</span>
      </div>
    </div>
  `;
}

function barsMarkup(days) {
  if (!days?.length) return `<p class="sub">暂无数据</p>`;
  const max = Math.max(...days.map((day) => day.neurons), 1);
  return `
    <div class="bars">
      ${days
        .map((day, index) => {
          const height = Math.max(4, (day.neurons / max) * 100);
          const isToday = index === days.length - 1;
          return `
            <div class="bar-col">
              <div class="bar-wrap">
                <span class="bar-value">${fmt(day.neurons)}</span>
                <div class="bar ${isToday ? "today" : ""}" style="height:${height}%"></div>
              </div>
              <span class="bar-label">${esc(day.label.slice(5))}</span>
            </div>
          `;
        })
        .join("")}
    </div>
  `;
}

function modelsMarkup(models) {
  if (!models?.length) return `<p class="sub">这个时间窗口还没有调用记录。</p>`;
  return `
    <table>
      <thead>
        <tr>
          <th>模型</th>
          <th>请求</th>
          <th>输入</th>
          <th>输出</th>
          <th>Neurons</th>
        </tr>
      </thead>
      <tbody>
        ${models
          .map(
            (model) => `
          <tr>
            <td class="mono">${esc(model.label)}</td>
            <td class="mono">${fmt(model.requests, 0)}</td>
            <td class="mono">${fmt(model.input_tokens, 0)}</td>
            <td class="mono">${fmt(model.output_tokens, 0)}</td>
            <td class="mono">${fmt(model.neurons, 2)}</td>
          </tr>`,
          )
          .join("")}
      </tbody>
    </table>
  `;
}

function usageSetupMarkup(payload) {
  const setup = payload?.setup ?? {};
  return `
    <section class="card">
      <h2>用量统计还没开通</h2>
      <p class="sub">
        统计页读取 Cloudflare 的 GraphQL Analytics（<code>aiInferenceAdaptiveGroups</code>），
        需要一个只读的 API Token。配好之后这里会显示今日用量、剩余 neurons 和 7 天曲线。
      </p>
      <ol class="steps">
        <li>Dashboard → My Profile → API Tokens → Create Token</li>
        <li>权限选 <code>${esc(setup.permission ?? "Account → Account Analytics → Read")}</code></li>
        <li>把 account id 和 token 写进 Worker secret：</li>
      </ol>
      <pre>${esc((setup.commands ?? []).join("\n"))}</pre>
      <p class="sub" style="margin-top:14px">
        写入后无需重新部署，刷新本页即可。
      </p>
    </section>
  `;
}

function renderStats() {
  if (!state.stats && !state.statsLoading && !state.statsError) {
    loadStats();
  }

  if (state.statsLoading && !state.stats) {
    return `
      <section class="card"><div class="skeleton" style="width:40%;margin-bottom:14px"></div>
      <div class="skeleton" style="width:100%;height:120px"></div></section>
    `;
  }

  if (state.statsError) {
    return `
      <section class="card">
        <h2>读取用量失败</h2>
        <p class="sub">${esc(state.statsError)}</p>
        <button class="btn secondary" id="retry-stats">重试</button>
      </section>
    `;
  }

  const stats = state.stats;
  if (stats && stats.configured === false) {
    return usageSetupMarkup(stats) + `<button class="btn secondary" id="retry-stats" style="justify-self:start">已配置，刷新</button>`;
  }

  const today = stats.today;
  const percent = today.percent;

  return `
    <section class="card">
      <h2>今日用量</h2>
      <p class="sub">免费额度每天 ${fmt(stats.free_neurons_per_day, 0)} neurons（UTC 00:00 重置），数据来自 Cloudflare Analytics。</p>
      <div class="stat-hero">
        ${ringMarkup(percent)}
        <div class="stat-grid">
          <div class="metric">
            <div class="k">剩余 neurons</div>
            <div class="v">${fmt(today.remaining)} <small>/ ${fmt(stats.free_neurons_per_day, 0)}</small></div>
          </div>
          <div class="metric">
            <div class="k">今日请求</div>
            <div class="v">${fmt(today.requests, 0)} <small>次</small></div>
          </div>
          <div class="metric">
            <div class="k">今日 tokens</div>
            <div class="v">${fmt(today.input_tokens + today.output_tokens, 0)} <small>in ${fmt(today.input_tokens, 0)} / out ${fmt(today.output_tokens, 0)}</small></div>
          </div>
          <div class="metric">
            <div class="k">估算费用</div>
            <div class="v">$${Number(today.cost_usd ?? 0).toFixed(5)}</div>
          </div>
        </div>
      </div>
    </section>

    <div class="row split">
      <section class="card">
        <h2>最近 ${stats.days.length} 天</h2>
        <p class="sub">窗口内合计 ${fmt(stats.window_neurons)} neurons</p>
        ${barsMarkup(stats.days)}
      </section>
      <section class="card">
        <h2>按模型拆分</h2>
        <p class="sub">同一窗口内各模型的消耗</p>
        ${modelsMarkup(stats.models)}
      </section>
    </div>

    <div class="row">
      <section class="card">
        <h2>快捷入口</h2>
        <p class="sub">把接口接到你的浏览器插件、客户端或代码里。</p>
        <div class="controls">
          <button class="btn secondary" id="goto-setup">查看接入方式 →</button>
          <button class="btn secondary" id="goto-translate">打开翻译面板 →</button>
          <button class="btn secondary" id="refresh-stats">刷新数据</button>
        </div>
      </section>
    </div>
  `;
}

async function loadStats() {
  state.statsLoading = true;
  state.statsError = null;
  try {
    state.stats = await api("/api/usage?days=7");
  } catch (error) {
    state.statsError = error.message === "unauthorized" ? "密钥已失效" : error.message;
  } finally {
    state.statsLoading = false;
    if (currentPath() === "/stats") {
      render();
    }
  }
}

/* ---------- translate ---------- */

function modelOptions(selected) {
  const fallback = state.session?.model ?? "";
  const options = [
    `<option value="" ${selected ? "" : "selected"}>默认 · ${esc(fallback)}</option>`,
  ];
  for (const model of state.models ?? []) {
    const label = `${model.label}${model.reasoning ? " · reasoning" : ""}`;
    const isSelected = selected === model.id ? "selected" : "";
    options.push(
      `<option value="${esc(model.id)}" ${isSelected} title="${esc(model.note)}">${esc(label)}</option>`,
    );
  }
  return options.join("");
}

function renderTranslate() {
  const result = state.translate.result;
  const error = state.translate.error;
  const draft = state.draft;
  const maxChars = state.session?.limits?.max_text_chars ?? 20000;

  return `
    <section class="card">
      <div class="row split">
        <div class="pane">
          <div class="pane-head">
            <h3>原文</h3>
            <span class="spacer"></span>
            <span class="counter" id="counter">0 / ${fmt(maxChars, 0)}</span>
          </div>
          <textarea id="src" placeholder="粘贴要翻译的内容…（⌘/Ctrl + Enter 提交）">${esc(draft.text)}</textarea>
        </div>
        <div class="pane">
          <div class="pane-head">
            <h3>译文</h3>
            <span class="spacer"></span>
            <button class="btn secondary" id="copy-out" ${result ? "" : "disabled"}>复制</button>
          </div>
          <div class="out ${result ? "" : "empty"}" id="out">${result ? "" : "译文会显示在这里。"}</div>
        </div>
      </div>

      <div class="controls" style="margin-top:18px">
        <label class="field">
          <span>模型</span>
          <select id="model">${modelOptions(draft.model)}</select>
        </label>
        <label class="field">
          <span>目标语言</span>
          <select id="target">${LANGS.map(
            ([code, label]) => `<option value="${code}" ${code === draft.target ? "selected" : ""}>${label} · ${code}</option>`,
          ).join("")}</select>
        </label>
        <label class="field">
          <span>源语言</span>
          <select id="source">
            <option value="auto" ${draft.source === "auto" ? "selected" : ""}>自动识别</option>
            ${LANGS.map(
              ([code, label]) =>
                `<option value="${code}" ${draft.source === code ? "selected" : ""}>${label} · ${code}</option>`,
            ).join("")}
          </select>
        </label>
        <label class="field">
          <span>语气（可选）</span>
          <input id="tone" type="text" placeholder="formal / casual / 营销" value="${esc(draft.tone)}" />
        </label>
        <button class="btn" id="run-translate" ${state.translate.busy ? "disabled" : ""}>
          ${state.translate.busy ? "翻译中…" : "翻译"}
        </button>
      </div>

      ${error ? `<p class="login-error" style="margin-top:16px">${esc(error)}</p>` : ""}
      ${
        result
          ? `<div class="meta">
               <span>model <b>${esc(result.model)}</b></span>
               <span>chunks <b>${result.chunks}</b></span>
               <span>tokens <b>${fmt(result.tokens.total, 0)}</b></span>
               <span>耗时 <b>${fmt(result.duration_ms, 0)} ms</b></span>
               <span>request <b>${esc(result.request_id)}</b></span>
             </div>`
          : ""
      }
    </section>
  `;
}

function translateMeta(payload) {
  const meta = payload.meta ?? {};
  return {
    model: meta.model,
    chunks: meta.chunks,
    tokens: meta.tokens ?? { total: 0 },
    duration_ms: meta.duration_ms,
    request_id: payload.request_id,
  };
}

async function runTranslate() {
  const { text, target, source, tone, model } = state.draft;
  if (!text.trim()) {
    toast("先输入要翻译的内容", true);
    return;
  }

  state.translate.busy = true;
  state.translate.error = null;
  render();
  try {
    const payload = await api("/translate", {
      method: "POST",
      body: {
        text,
        target_lang: target,
        source_lang: source,
        tone: tone || undefined,
        model: model || undefined,
      },
    });
    state.translate.result = translateMeta(payload);
    state.translate.result.text = payload.translation;
  } catch (error) {
    state.translate.error = error.message === "unauthorized" ? "密钥已失效" : error.message;
  } finally {
    state.translate.busy = false;
    render();
  }
}

/* ---------- setup ---------- */

function setupValues() {
  const origin = location.origin;
  return {
    base: `${origin}/v1`,
    endpoint: `${origin}/v1/chat/completions`,
    model: state.session?.model ?? "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    key: state.key,
    translate: `${origin}/translate`,
  };
}

function kvRow(label, value) {
  return `
    <div class="kv-row">
      <div class="k">${esc(label)}</div>
      <div class="v"><span>${esc(value)}</span><button data-copy="${esc(value)}">复制</button></div>
    </div>
  `;
}

function renderSetup() {
  const v = setupValues();
  const tab = state.setupTab;

  const panel = {
    plugin: `
      <p class="sub">以「沉浸式翻译」为例，其它客户端填法一致：Base URL + 同一个 Key + 模型名。</p>
      <div class="kv">
        ${kvRow("API Key", v.key)}
        ${kvRow("自定义 API 地址", v.endpoint)}
        ${kvRow("模型", v.model)}
      </div>
      <ol class="steps" style="margin-top:16px">
        <li>设置 → 翻译服务 → 添加翻译服务 → 搜索 <code>OpenAI</code> → 选「OpenAI (ChatGPT)」</li>
        <li>API Key 填上面的值，自定义 API 地址填上面的地址</li>
        <li>模型填上面的模型名（也可以填 <code>gpt-4o-mini</code>，会被映射到默认模型）</li>
        <li>点「测试服务」，通过后保存</li>
      </ol>
    `,
    sdk: `
      <p class="sub">任何 OpenAI SDK 都能直接用，只需要改 base_url 和 api_key。</p>
      <pre>from openai import OpenAI

client = OpenAI(base_url="${esc(v.base)}", api_key="${esc(v.key)}")

resp = client.chat.completions.create(
    model="gpt-4o-mini",  # 任意名字都会映射到默认模型
    messages=[
        {"role": "system", "content": "Translate into Simplified Chinese. Output only the translation."},
        {"role": "user", "content": "The edge is fast."},
    ],
)
print(resp.choices[0].message.content)</pre>
      <pre>import OpenAI from "openai";

const client = new OpenAI({ baseURL: "${esc(v.base)}", apiKey: "${esc(v.key)}" });
const res = await client.chat.completions.create({
  model: "gpt-4o-mini",
  messages: [{ role: "user", content: "Translate to Chinese: hello" }],
});
console.log(res.choices[0].message.content);</pre>
    `,
    curl: `
      <p class="sub">OpenAI 兼容接口，支持 <code>stream: true</code> 的 SSE。</p>
      <pre>curl -s ${esc(v.endpoint)} \\
  -H 'content-type: application/json' \\
  -H 'authorization: Bearer ${esc(v.key)}' \\
  -d '{
    "model": "gpt-4o-mini",
    "messages": [
      {"role": "system", "content": "Translate into Simplified Chinese. Output only the translation."},
      {"role": "user", "content": "The edge is fast."}
    ]
  }'</pre>
      <pre>curl -s ${esc(v.translate)} \\
  -H 'content-type: application/json' \\
  -H 'authorization: Bearer ${esc(v.key)}' \\
  -d '{"text":"The edge is fast.","target_lang":"zh-CN"}'</pre>
    `,
    limits: `
      <p class="sub">服务端当前的限制与配置。</p>
      <div class="kv">
        ${kvRow("Base URL", v.base)}
        ${kvRow("单请求最大字符", fmt(state.session?.limits?.max_text_chars, 0))}
        ${kvRow("分片阈值（字符）", fmt(state.session?.limits?.chunk_chars, 0))}
        ${kvRow("分片并发", fmt(state.session?.limits?.max_concurrency, 0))}
        ${kvRow("单分片最大输出 tokens", fmt(state.session?.limits?.max_output_tokens, 0))}
        ${kvRow("AI Gateway", state.session?.gateway ?? "-")}
        ${kvRow("用量统计", state.session?.features?.usage_analytics ? "已配置" : "未配置")}
      </div>
    `,
  }[tab];

  return `
    <section class="card">
      <h2>接入方式</h2>
      <p class="sub">所有字段都可以点「复制」。当前服务地址：<b>${esc(location.origin)}</b></p>
      <div class="tabs">
        <button data-tab="plugin" class="${tab === "plugin" ? "active" : ""}">插件</button>
        <button data-tab="sdk" class="${tab === "sdk" ? "active" : ""}">SDK</button>
        <button data-tab="curl" class="${tab === "curl" ? "active" : ""}">curl</button>
        <button data-tab="limits" class="${tab === "limits" ? "active" : ""}">限制</button>
      </div>
      ${panel}
    </section>
  `;
}

/* ---------- event delegation ---------- */

document.addEventListener("click", (event) => {
  const copyTarget = event.target.closest("[data-copy]");
  if (copyTarget) {
    copy(copyTarget.dataset.copy);
    return;
  }

  const tab = event.target.closest("[data-tab]");
  if (tab) {
    state.setupTab = tab.dataset.tab;
    render();
    return;
  }

  switch (event.target.id) {
    case "refresh-stats":
    case "retry-stats":
      state.stats = null;
      state.statsError = null;
      state.statsLoading = false;
      render();
      break;
    case "goto-setup":
      navigate("/setup");
      break;
    case "goto-translate":
      navigate("/translate");
      break;
    case "run-translate":
      runTranslate();
      break;
    case "copy-out": {
      const out = document.getElementById("out");
      if (out && state.translate.result) copy(out.textContent);
      break;
    }
  }
});

document.addEventListener("input", (event) => {
  const { id, value } = event.target;
  if (id === "src") {
    state.draft.text = value;
    updateCounter();
  } else if (id === "model") state.draft.model = value;
  else if (id === "target") state.draft.target = value;
  else if (id === "source") state.draft.source = value;
  else if (id === "tone") state.draft.tone = value;
});

document.addEventListener("change", (event) => {
  const { id, value } = event.target;
  if (id === "model") state.draft.model = value;
  else if (id === "target") state.draft.target = value;
  else if (id === "source") state.draft.source = value;
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
    if (currentPath() === "/translate" && state.session) {
      event.preventDefault();
      runTranslate();
    }
  }
});

document.addEventListener("submit", (event) => event.preventDefault());
