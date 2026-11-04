# neuron-translate

Cloudflare Workers 上的翻译服务：**Python Worker + Workers AI + AI Gateway + Workers Tracing**。

> 仓库名 `neuron-translate`，Worker 服务名是 `trans`（见 `wrangler.jsonc`）。改 Worker 名会导致自定义域需要重新绑定，所以两者故意不一致。

- `POST /v1/chat/completions`：**OpenAI 兼容**接口，可直接给沉浸式翻译、NextChat、Cherry Studio、Bob 等插件/客户端用
- `POST /translate`：自用的翻译接口，内建分片、术语表（glossary）、语气（tone）
- 所有模型调用都经过 **AI Gateway**：统一日志、可选响应缓存、自定义 metadata（可按请求 ID 检索）
- **Workers Traces** 自动采集 handler / binding 调用的 span，可导出到任意 OTel 后端
- `GET /` 自带一个浏览器调试页，`GET /healthz` 用于健康检查

> 从 `worker.py` 到 `provider`、`translator`、`http_adapter` 每一层都只依赖抽象，方便替换模型或换个入口（HTTP、队列、Cron）。

---

## 目录结构

```
wrangler.jsonc           # Worker 配置：AI binding、observability.traces、运行参数
src/worker.py            # WorkerEntrypoint：装配依赖，转成 Workers Response
src/http_adapter.py      # 路由 / CORS / 鉴权 / 错误渲染（与运行时无关，可单测）
src/app.py               # 用例层：校验 → 翻译 → 打点
src/translator.py        # 分片、并发、AI Gateway metadata、缓存 key、结果拼装
src/chat_validation.py   # OpenAI 请求体校验（messages / stream / 温度 / max_tokens）
src/chat_service.py      # OpenAI → Workers AI 转发、模型名映射
src/openai_format.py     # OpenAI 响应体 / SSE 帧 / 错误体 / models 列表
src/chunking.py          # 按段落/句子切分长文，拼接时可还原原文结构
src/prompting.py         # 翻译 prompt、语言名称映射
src/worker_ai.py         # Workers AI provider（env.AI + AI Gateway options）
src/response_parser.py   # 兼容 response / choices / output 多种返回结构
src/settings.py          # 从 env 读取配置（带类型转换与默认值）
src/observability.py     # 结构化 JSON 日志
tests/                   # 86 个纯 Python 单测，不需要 Workers 运行时
```

## 快速开始

前置：`uv`（≥ 0.13.4）、Node.js。

```bash
uv sync
cp .dev.vars.example .dev.vars       # 本地开发用的可选 API Token

uv run pywrangler dev                # 需要 `wrangler login`，AI binding 走远端推理
curl -s localhost:8787/healthz

curl -s localhost:8787/translate \
  -H 'content-type: application/json' \
  -d '{"text":"Cloudflare Workers AI is fast.","target_lang":"zh-CN"}'
```

响应示例：

```json
{
  "request_id": "a1b2c3d4e5f6",
  "translation": "Cloudflare Workers AI 很快。",
  "meta": {
    "model": "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    "gateway": "default",
    "chunks": 1,
    "cached_chunks": 0,
    "tokens": { "prompt": 132, "completion": 24, "total": 156 },
    "duration_ms": 780
  }
}
```

部署：

```bash
uv run pywrangler deploy
uv run pywrangler secret put TRANSLATION_API_TOKEN   # 可选，开启鉴权
```

部署后地址：

| 用途 | URL |
| --- | --- |
| OpenAI 兼容 Base URL | `https://<worker>.<subdomain>.workers.dev/v1` |
| OpenAI 兼容完整路径 | `.../v1/chat/completions` |
| 自用翻译接口 | `.../translate` |
| 浏览器调试页 | `.../` |

### 绑定自定义域（可选）

`wrangler.jsonc` 刻意不写 `routes`，避免把个人域名提交进仓库。自定义域只需要挂一次，之后 `pywrangler deploy` 不会动它：

- Dashboard：**Workers & Pages → trans → Settings → Domains & Routes → Add → Custom domain**（Cloudflare 自动建 DNS 记录和证书）
- 或 API：

```bash
curl -X PUT "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/domains" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H 'content-type: application/json' \
  -d '{"zone_id":"<你的 zone id>","hostname":"trans.example.com","service":"trans","environment":"production"}'
```

挂上后把上面表格里的地址换成你的域名即可（例如 `https://trans.example.com/v1`）。

> 注意：`workers_dev: true` 会同时保留 `<worker>.<subdomain>.workers.dev` 入口。不想暴露就在部署前把它改成 `false`（接口本身有 token 保护，不会裸奔）。
> 另外 `*.workers.dev` 在部分网络（如中国内地）被污染/阻断，这种情况只能走自定义域。

## OpenAI 兼容接口（给插件 / 客户端用）

| 配置项 | 值 |
| --- | --- |
| Base URL | `https://trans.example.com/v1` |
| API Key | 配了 `TRANSLATION_API_TOKEN` 就填它；没配则任意字符串（如 `sk-local`） |
| Model | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` |

- 模型名无所谓：非 `@cf/` 开头的一律映射到默认模型（所以填 `gpt-4o-mini`、`gpt-3.5-turbo` 也能用）；`@cf/` 开头的会原样透传
- 请求里的 `messages` 原样转给模型，插件自带的 system prompt 会生效
- 额外可选字段 `target_lang` / `tone` / `glossary`，会以追加 system 规则的方式注入（标准客户端不需要）
- `stream: true` 返回 SSE：`role` → `content` → `stop` + `[DONE]`，`stream_options.include_usage` 会在最后一帧带 usage
- 错误为 OpenAI 格式：`{"error":{"message","type","param","code"}}`

```bash
# 非流式
curl -s https://trans.example.com/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{
    "model": "gpt-4o-mini",
    "messages": [
      {"role": "system", "content": "Translate into Simplified Chinese. Output only the translation."},
      {"role": "user", "content": "Latency matters at the edge."}
    ]
  }'

# 流式
curl -sN https://trans.example.com/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"gpt-4o-mini","stream":true,"messages":[{"role":"user","content":"Translate to Japanese: Good morning"}]}'

# 模型列表（很多客户端会先拉这个）
curl -s https://trans.example.com/v1/models
```

各客户端怎么填：

| 客户端 | 填法 |
| --- | --- |
| 沉浸式翻译 | 设置 → 翻译服务 → 添加 → OpenAI（ChatGPT）：API Key 填 `TRANSLATION_API_TOKEN`；自定义 API 地址填 `https://<你的域名>/v1/chat/completions`；模型填 `@cf/meta/llama-3.3-70b-instruct-fp8-fast`；保持「流式输出」开启 |
| NextChat / Cherry Studio | 自定义 OpenAI：Base URL `https://trans.example.com/v1`，模型自定义填上面的模型名 |
| Bob / Pot 等 macOS 工具 | OpenAI 兼容 → API 域名 `trans.example.com`，路径 `/v1/chat/completions` |
| 代码里用 openai SDK | `OpenAI(base_url="https://trans.example.com/v1", api_key="sk-local")` |

> 流式的实现是「整段生成完再按 SSE 分帧下发」，客户端解析完全兼容，但不是逐 token 出字，首字延迟 ≈ 整段生成时间。要真流式需要把 `env.AI.run(..., {"stream": true})` 返回的 ReadableStream 直接透传，见文末「已知边界」。

## 鉴权

`/translate` 与 `/v1/chat/completions` 都要求鉴权（配了 `TRANSLATION_API_TOKEN` 时）：

```
Authorization: Bearer <TRANSLATION_API_TOKEN>
# 或 X-API-Key: <TRANSLATION_API_TOKEN>
```

`/healthz`、`/v1/models`、`/` 不需要鉴权（都不消耗 Workers AI 额度，模型列表只暴露模型 id）。

写入 / 轮换 token：

```bash
printf '%s' "sk-trans-$(openssl rand -hex 20)" | npx wrangler secret put TRANSLATION_API_TOKEN
# 本地开发同步写到 .dev.vars（已在 .gitignore 中）
```

## API

### `POST /translate`

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `text` | string | ✅ | 原文，默认上限 20000 字符 |
| `target_lang` | string | ➖ | 目标语言，默认 `en`，如 `zh-CN` / `ja` |
| `source_lang` | string | ➖ | 默认 `auto`，自动识别 |
| `tone` | string | ➖ | 语气要求，如 `formal`、`casual`、`marketing` |
| `glossary` | object | ➖ | 术语表 `{"workers": "无服务器"}`，最多 50 条 |
| `preserve_formatting` | bool | ➖ | 默认 `true`，保留 Markdown / HTML / 占位符 |

鉴权（配置了 `TRANSLATION_API_TOKEN` 时必填）：`Authorization: Bearer <token>` 或 `X-API-Key: <token>`。

错误统一格式，且都带 `request_id`：

```json
{ "request_id": "…", "error": { "code": "invalid_request", "message": "…", "field": "text" } }
```

### `GET /healthz`、`GET /`（调试页）

## 配置（`wrangler.jsonc` 的 `vars`）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `TRANSLATION_MODEL` | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | 任意 Workers AI 模型；也可用第三方模型，见下 |
| `AI_GATEWAY_ID` | `default` | AI Gateway 名称，`default` 首次请求时自动创建 |
| `AI_GATEWAY_CACHE_TTL` | `0` | >0 时按内容哈希复用 AI Gateway 缓存（秒） |
| `AI_GATEWAY_COLLECT_LOGS` | `true` | 是否写 AI Gateway 日志（含请求/响应正文） |
| `TRANSLATION_CHUNK_CHARS` | `3000` | 单次推理的最大字符数 |
| `TRANSLATION_MAX_TEXT_CHARS` | `20000` | 单请求原文上限 |
| `TRANSLATION_MAX_CONCURRENCY` | `4` | 分片并发数（1–8） |
| `TRANSLATION_TEMPERATURE` | `0.1` | 采样温度 |
| `TRANSLATION_MAX_OUTPUT_TOKENS` | `2048` | 单分片输出上限 |
| `CORS_ALLOWED_ORIGINS` | `*` | 逗号分隔的白名单 |
| `PLAYGROUND_ENABLED` | `true` | 是否暴露 `/` 调试页 |

> `llama-3.1-8b-instruct` 已于 2026-05-30 下线，默认模型换成 `llama-3.3-70b-instruct-fp8-fast`（实测可用）。
> 带 reasoning 的模型（`qwen3-30b-a3b-fp8`、`gpt-oss-120b`）会先输出思考内容、正文可能为空，用作纯翻译需额外关掉 thinking，暂不建议。
>
> 若想用 OpenAI / Anthropic 等第三方模型，直接把 `TRANSLATION_MODEL` 设为 `openai/gpt-4.1-mini` 之类的 ID（需开启 AI Gateway Unified Billing）；代码无需改动。

---

## Tracing / 可观测性

这套方案有三层可观测数据，互相用 `request_id` 关联：

### 1. Workers Traces（平台自动埋点）

`wrangler.jsonc`：

```jsonc
"observability": {
  "enabled": true,
  "traces": { "enabled": true, "head_sampling_rate": 1 },
  "logs":   { "enabled": true, "head_sampling_rate": 1 }
}
```

- 自动采集 fetch handler 生命周期、Workers AI binding 调用、出网子请求的 span，无需写代码
- `head_sampling_rate` 默认 `1`（100%）。生产高 QPS 建议降到 `0.05` 之类的比例（`0` 表示不采样）
- 在 Dashboard → Workers → 你的 Worker → Observability → Traces 查看瀑布图
- 需要接入 Grafana / Honeycomb / Axiom 时，用 [OpenTelemetry export](https://developers.cloudflare.com/workers/observability/opentelemetry-export/)，`persist: false` 可只外发不落 Cloudflare

### 2. AI Gateway 日志（模型调用级）

每次 `env.AI.run` 都会带上：

```python
{
  "gateway": {
    "id": "default",
    "collectLog": True,
    "cacheTtl": 0,
    "metadata": {
      "request_id": "…", "target_lang": "zh-CN",
      "source_lang": "auto", "chunk": "1/3", "chars": 2900
    }
  }
}
```

- AI Gateway 单次请求最多保存 5 个 metadata 键（本实现正好 5 个，有单测覆盖）
- Dashboard → AI Gateway → Logs 可按 `request_id` 过滤，看到每片的 prompt / 响应 / token / 耗时
- `AI_GATEWAY_CACHE_TTL > 0` 时用 `sha256(model + system prompt + 原文)` 作为 cache key，命中会体现在 `meta.cached_chunks`

### 3. 结构化日志（`JsonLogger`）

每个请求一行 JSON，`wrangler tail` 直接可读可 grep：

```json
{"service":"trans","level":"info","event":"translation.completed","request_id":"…","model":"@cf/meta/llama-3.3-70b-instruct-fp8-fast","gateway":"default","chunks":1,"input_chars":28,"duration_ms":780,"tokens":{"prompt":132,"completion":24,"total":156}}
```

失败路径会打 `request.failed`（含 code/status），未捕获异常打 `request.crashed`。

### 隐私提醒

- Workers Traces 是**平台级**埋点，不包含 prompt 正文
- AI Gateway 日志默认会保存请求/响应正文（即用户文本）。若内容敏感，把 `AI_GATEWAY_COLLECT_LOGS` 设为 `false`，或在 Gateway 侧配置 DLP / 只在测试环境开日志
- 不要把 API Token、用户 PII 放进 AI Gateway metadata（metadata 会长期存储）

---

## 查看额度 / 用量

免费额度是 **10,000 neurons/天**（UTC 00:00 重置），但 CF 控制台里没有「剩余额度」这个数字，只有「今天已用」的曲线，所以容易找不到：

- 控制台：`https://dash.cloudflare.com/?to=/:account/ai/workers-ai` → 左侧 **AI → Workers AI**，页面上的 Usage / Neurons 图（另有 **AI Gateway → default → Analytics** 看单网关的请求量与成本）
- 命令行（按模型拆分、直接算占比和超额费用）：

```bash
python3 scripts/neuron_usage.py            # 最近 1 天
python3 scripts/neuron_usage.py --days 7   # 最近 7 天（上限 7）
python3 scripts/neuron_usage.py --json     # 给脚本/告警用
```

脚本通过 Cloudflare GraphQL Analytics `aiInferenceAdaptiveGroups` 拉数据，凭据顺序：`CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` 环境变量 → 否则复用本机 `wrangler login` 的 OAuth token（会自动解析 account id）。

## 开发与校验

```bash
uv run pytest                      # 86 个单测（纯 CPython，不依赖 Workers 运行时）
uv run ruff format src tests
uv run ruff check src tests
uv run pywrangler deploy --dry-run --outdir dist   # 校验打包（47 个模块）
```

本地已验证：`/healthz`、`/`、`/translate`（缺少 AI binding 时返回结构化 502）、400/404 分支，以及 `observability.traces` 在本地 workerd 中确实产出 span。

## 已知边界

- OpenAI 兼容接口的流式是「生成完成后按 SSE 分帧」，不是逐 token 流。要真流式：`WorkersAiProvider` 增加 `stream: true`，把 binding 返回的 `ReadableStream` 经 `Response` 直接透传（Python Worker 里用 `js` 侧对象包装），`HttpAdapter` 跳过 `OpenAiFormatter.stream_body`
- 纯文本/Markdown 效果好；代码块的逐行保护仅依赖 prompt，如需强保证可改为先抽取占位符再回填
- Python Workers 仍处于 beta：`pywrangler` 需要 `uv >= 0.13.4`，且 AI binding 在本地 `dev` 时需要登录以走远端推理
