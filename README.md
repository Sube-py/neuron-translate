# neuron-translate

Cloudflare 上的翻译服务：**TypeScript Worker + Workers AI + AI Gateway + Workers Tracing**。

- `POST /v1/chat/completions`：**OpenAI 兼容**，SSE **逐 token 真流式**，可直接给沉浸式翻译、NextChat、Cherry Studio、Bob 等用
- `POST /translate`：内建分片、术语表、语气、模型覆盖
- `GET /`：Web 控制台（登录 / 用量 / 翻译 / 接入）
- 所有推理走 AI Gateway：日志、缓存、metadata、限流；Worker 侧开启 tracing

> 仓库名 `neuron-translate`，Worker 服务名是 `trans`（见 `wrangler.jsonc`）。改 Worker 名会导致自定义域需要重新绑定，所以两者故意不一致。

## 特性

| | |
| --- | --- |
| 真流式 | `env.AI.run(..., { stream: true })` → `TransformStream` 重组成 OpenAI SSE，无额外 token、无中继 |
| 长文 | 按段落/句子切分，并发翻译后按原分隔符拼回 |
| 模型选择 | 内置模型清单，支持全名或 `glm-4.7-flash` 这类短名；reasoning 模型可用 |
| 护栏 | Bearer 鉴权、CORS 白名单、字符/并发上限、2MB body |
| 观测 | Workers Traces 自动 span、AI Gateway 调用日志（带 `request_id`）、结构化 JSON 日志 |
| 用量 | `/api/usage` 读 Cloudflare GraphQL Analytics，展示今日 neurons / 剩余额度 / 按模型拆分 |

## 目录结构

```
wrangler.jsonc            # AI binding、静态资源、observability.traces、vars
src/worker.ts            # Worker 入口：装配依赖，/api 与静态资源分流
src/http/router.ts       # 路由 / CORS / 鉴权 / 错误渲染 / 静态回退
src/http/auth.ts         # Bearer + X-API-Key 校验（常数时间比较）
src/config/settings.ts   # env → Settings（类型转换 + 默认值）
src/translate/           # 校验、分片、prompt、并发编排
src/chat/                # OpenAI 请求校验、服务、SSE 重组
src/provider/            # Workers AI 调用、AI Gateway 选项、响应解析、模型目录
src/audio/               # TTS 模型目录、校验、合成（自动识别 WAV/MP3）
src/usage/               # GraphQL 客户端 + 每日/按模型聚合
src/observability/       # JSON 日志
web/                     # 静态 SPA（无构建步骤）：登录 / 用量 / 翻译 / 语音 / 接入
tests/                   # 104 个 vitest 单测，不需要 Workers 运行时
scripts/neuron-usage.mjs # 命令行查当日 neurons 用量
```

## 快速开始

```bash
npm install
cp .dev.vars.example .dev.vars      # 本地开发用的可选 API Token
npx wrangler login                  # 一次性授权
npm run dev                         # http://localhost:8787
```

```bash
curl -s localhost:8787/translate \
  -H 'content-type: application/json' \
  -d '{"text":"Cloudflare Workers AI is fast.","target_lang":"zh-CN"}'
```

部署：

```bash
npm run deploy
printf '%s' "$TOKEN" | npx wrangler secret put TRANSLATION_API_TOKEN --name trans   # 可选，开启鉴权
```

| 用途 | URL |
| --- | --- |
| OpenAI Base URL | `https://<worker>.<subdomain>.workers.dev/v1` |
| 自用翻译接口 | `.../translate` |
| Web 控制台 | `.../` |

### 绑定自定义域（可选）

`wrangler.jsonc` 刻意不写 `routes`，避免把个人域名提交进仓库。自定义域挂一次，之后 `wrangler deploy` 不会动它：

- Dashboard：**Workers & Pages → trans → Settings → Domains & Routes → Add → Custom domain**
- 或 API：

```bash
curl -X PUT "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/domains" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H 'content-type: application/json' \
  -d '{"zone_id":"<zone id>","hostname":"trans.example.com","service":"trans","environment":"production"}'
```

> `workers_dev: true` 会保留 `*.workers.dev` 入口；不想暴露就改成 `false` 再部署。

## 鉴权

`/translate`、`/v1/chat/completions`、`/api/*` 需要鉴权（配置了 `TRANSLATION_API_TOKEN` 时）：

```
Authorization: Bearer <token>
# 或 X-API-Key: <token>
```

`/healthz`、`/v1/models`、`/` 与静态资源不需要鉴权（不消耗推理额度）。

```bash
printf '%s' "sk-trans-$(openssl rand -hex 20)" | npx wrangler secret put TRANSLATION_API_TOKEN --name trans
```

## OpenAI 兼容接口

| 配置项 | 值 |
| --- | --- |
| Base URL | `https://<你的域名>/v1` |
| API Key | `TRANSLATION_API_TOKEN` |
| Model | 任意名字都可以；非 `@cf/` 前缀会映射到默认模型 |

```bash
# 非流式
curl -s https://<域名>/v1/chat/completions -H 'content-type: application/json' \
  -H 'authorization: Bearer <key>' -d '{
    "model": "gpt-4o-mini",
    "messages": [
      {"role": "system", "content": "Translate into Simplified Chinese. Output only the translation."},
      {"role": "user", "content": "Latency matters at the edge."}
    ]
  }'

# 流式（逐 token）
curl -sN https://<域名>/v1/chat/completions -H 'content-type: application/json' \
  -H 'authorization: Bearer <key>' -d '{"model":"gpt-4o-mini","stream":true,"messages":[{"role":"user","content":"Translate to Japanese: good morning"}]}'
```

- `stream_options.include_usage = true` 时最后一帧带 `usage`
- 支持 `target_lang` / `tone` / `glossary` 作为额外 system 规则注入（标准客户端不需要）
- 错误为 OpenAI 格式：`{"error":{"message","type","param","code"}}`
- reasoning 模型（glm-4.7-flash / gemma-4 / qwen3 / gpt-oss）：不传 `max_tokens` 时不下发该字段，模型按自身预算生成；思考吃光预算会返回 `reasoning_budget_exhausted`

### 客户端填法

| 客户端 | 填法 |
| --- | --- |
| 沉浸式翻译 | 设置 → 翻译服务 → 添加 → OpenAI（ChatGPT）：API Key 填 token；自定义 API 地址 `https://<域名>/v1/chat/completions`；模型 `@cf/meta/llama-3.1-8b-instruct-fp8-fast`；保持「流式输出」开启 |
| NextChat / Cherry Studio | 自定义 OpenAI：Base URL `https://<域名>/v1` |
| Bob / Pot | API 域名 `<域名>`，路径 `/v1/chat/completions` |
| SDK | `OpenAI(base_url="https://<域名>/v1", api_key="<token>")` |

## 语音合成 `POST /v1/audio/speech`

兼容 OpenAI 的 speech 接口，返回音频二进制（`content-type` 按实际容器自动识别）。

```bash
curl -s https://<域名>/v1/audio/speech -H 'content-type: application/json' \
  -H 'authorization: Bearer <key>' \
  -d '{"model":"melotts","input":"你好，世界","lang":"zh"}' -o speech.wav
```

| 模型 | 价格 | 实测延迟 | 84 字符的估算 neurons | 输出 |
| --- | --- | --- | --- | --- |
| `@cf/myshell-ai/melotts` | $0.000205 / 音频分钟 | **~0.6s** | **~1.7** | WAV（未压缩，约 450KB/7s） |
| `@cf/deepgram/aura-1` | $0.015 / 1k 字符 | ~0.7s | ~115 | MP3 48kbps（34KB） |
| `@cf/deepgram/aura-2-en` | $0.030 / 1k 字符 | ~2.9s | ~229 | MP3 48kbps（43KB） |

- 支持 `model`（全名或短名：`melotts` / `aura-1` / `aura-2-en`）、`input`、`voice`、`lang`
- 响应头带 `x-tts-model`、`x-tts-neurons`（估算）、`x-tts-duration-ms`
- 模型清单：`GET /api/models?kind=tts`
- 结论：**MeloTTS 又便宜又快**，适合逐段朗读/翻译后朗读；Aura 系列更自然但贵 60–130 倍，只在需要播音级音色时用
- `aura-2-en` 只支持英文，传其它语言会直接 400

## 自用接口 `POST /translate`

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `text` | string | ✅ | 原文，上限 `TRANSLATION_MAX_TEXT_CHARS` |
| `target_lang` | string | ➖ | 默认 `en` |
| `source_lang` | string | ➖ | 默认 `auto` |
| `tone` | string | ➖ | 语气要求 |
| `glossary` | object | ➖ | `{"workers": "无服务器"}`，最多 50 条 |
| `preserve_formatting` | bool | ➖ | 默认 `true` |
| `model` | string | ➖ | 全名或短名，见 `GET /api/models` |

响应带 `meta`：model / gateway / chunks / cached_chunks / tokens / duration_ms。

## 控制台 API

| 接口 | 说明 |
| --- | --- |
| `GET /api/verify` | 校验 Key，返回模型、网关、限制 |
| `GET /api/models` | 对话模型清单（含 reasoning 标记） |
| `GET /api/models?kind=tts` | 语音模型清单（含价格、音色、语言） |
| `GET /api/usage?days=7` | 今日 / 近 7 天 neurons、剩余额度、按模型拆分 |

用量页需要两个 secret（只读分析 Token，浏览器拿不到）：

```bash
printf '%s' <account_id> | npx wrangler secret put ANALYTICS_ACCOUNT_ID --name trans
printf '%s' <api_token>  | npx wrangler secret put ANALYTICS_API_TOKEN --name trans
```

Token 权限：**Account → Account Analytics → Read**。没配置时用量页会直接显示这组命令，不影响翻译。

## 配置（`wrangler.jsonc` 的 `vars`）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `TRANSLATION_MODEL` | `@cf/meta/llama-3.1-8b-instruct-fp8-fast` | 默认模型 |
| `AI_GATEWAY_ID` | `default` | AI Gateway 名称 |
| `AI_GATEWAY_CACHE_TTL` | `0` | >0 时按内容哈希复用缓存（秒） |
| `AI_GATEWAY_COLLECT_LOGS` | `true` | 是否写 AI Gateway 日志（含正文） |
| `TRANSLATION_CHUNK_CHARS` | `3000` | 分片阈值 |
| `TRANSLATION_MAX_TEXT_CHARS` | `20000` | 单请求原文上限 |
| `TRANSLATION_MAX_OUTPUT_TOKENS` | `2048` | `/translate` 单分片输出上限（`/v1/*` 不传就不限制） |
| `TRANSLATION_TEMPERATURE` | `0.1` | 采样温度 |
| `TRANSLATION_MAX_CONCURRENCY` | `4` | 分片并发（1–8） |
| `CORS_ALLOWED_ORIGINS` | `*` | 逗号分隔白名单 |
| `USAGE_DAYS` | `7` | 用量窗口 |

## Tracing / 观测

1. **Workers Traces**：`observability.traces.enabled=true` + `head_sampling_rate=1`，自动采集 handler 与 `env.AI` binding 调用的 span，看 Dashboard → Workers → Observability → Traces
2. **AI Gateway 日志**：每次推理一条，带 `request_id` / `mode` / `chunk` / `chars` / `stream` 五个 metadata，可按 request_id 检索
3. **结构化日志**：`request.completed`（method/path/status/duration/user_agent）、`translation.completed`、`chat.completed`、`chat.streamed`、`usage.reported`

> AI Gateway 日志会保存请求/响应正文；敏感场景把 `AI_GATEWAY_COLLECT_LOGS` 设为 `false`。

## 移动端

控制台按移动端做了适配（断点 720px / 420px）：导航折成整行、表单控件全宽、统计环形图居中堆叠、模型表格在小屏收起「输入/输出」两列并用省略号截断模型名、播放器与译文按钮自动换行。用 390×844 视口实测过登录、用量、翻译+朗读、语音合成四个页面。

## 开发与校验

```bash
npm test             # 104 个单测（vitest）
npm run typecheck    # tsc --noEmit
npx wrangler deploy --dry-run --outdir dist   # 打包校验
node scripts/neuron-usage.mjs --days=1        # 当日 neurons 用量
```

## 已知边界

- `/translate` 一次性返回（内部可并发分片）；需要逐 token 的应用走 `/v1/chat/completions`
- 代码块/占位符保护依赖 prompt，极端格式仍需人工确认
- reasoning 模型首字更慢（思考阶段无输出），插件体验不如 8B/70B
- 自定义 span（`tracing.enterSpan`）还没接；需要时可在 `HttpApp` 里加
