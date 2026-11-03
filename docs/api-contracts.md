# 数据源 HTTP API 实测契约（HuggingFace / ModelScope）

> 本文件是 `docs/IPC-CONTRACT.md` 第 6 节的数据源实现依据：后端按本文件拼接 URL、解析字段、处理错误。
> 所有结论均来自真实网络请求（实测），每条都附命令与状态码。**未验证**的点单独标注，不猜测。
>
> - 实测时间：2026-11-03 18:49 – 19:00（+08:00，Asia/Shanghai）
> - 实测环境：Windows 11 + PowerShell 7.6.9（`Invoke-WebRequest` / Windows 自带 `curl.exe`），无代理
> - 可复跑脚本：[scripts/probe-hf.ps1](../scripts/probe-hf.ps1)、[scripts/probe-modelscope.ps1](../scripts/probe-modelscope.ps1)
> - Token：本机无可用 HF token / MS token，Token 相关行为用「不带 Token」「非法假 Token」验证；不含任何真实 token

## 0. 结论速览

| # | 能力 | 端点 | 实测结果 | 结论 |
|---|------|------|----------|------|
| 1 | HF 直连 | `https://huggingface.co` | 全部请求 TCP 超时（21.3s 连接失败；40s IWR 超时） | **本机不可用**，必须用镜像 |
| 2 | HF 镜像 | `https://hf-mirror.com` | API 搜索/详情/文件树 200；下载 307/302 → 200/206 | **可用**（推荐 `hfEndpoint` 填此值） |
| 3 | HF 搜索 | `GET {hf}/api/models?search=&limit=&sort=downloads&direction=-1&full=true` | 200；`Link: <...cursor=...>; rel="next"` | cursor 分页；`page/offset` 无效；列表需 `full=true` 才有 `gated/lastModified` |
| 4 | HF 文件树 | `GET {hf}/api/models/{repo}/tree/{rev}?recursive=true` | 200；条目含 `size`/`lfs.size`；`Link` cursor 分页 | 可翻页；host 要重写；默认每页 1000 |
| 5 | HF 下载 | `GET {hf}/{repo}/resolve/{rev}/{path}` | 小文件 307→200（Range 被忽略）；LFS 302→CDN 206+Content-Range | 只有 LFS 大文件可续传 |
| 6 | HF gated | 详情 API 可读（`gated:"manual"`）；下载无 Token | 403 + 英文提示 | 下载需 Token + 网页端授权 |
| 7 | MS 搜索 | **`PUT {ms}/api/v1/dolphin/models`** | 200；`Data.Model.Models[]` + `Data.Model.TotalCount` | **只有 PUT 可用**；GET/POST 均 404 |
| 8 | MS 详情 | `GET {ms}/api/v1/models/{repo}` | 200；`Data.*` 元信息齐全 | 可用 |
| 9 | MS 文件列表 | `GET {ms}/api/v1/models/{repo}/repo/files?Recursive=true` | 200；`Data.Files[]`，过滤 `Type=="blob"` | 可用（一次返回全部文件） |
| 10 | MS 下载 | `GET {ms}/models/{repo}/resolve/master/{path}` | 小文件直接 200；LFS 302→CDN；Range：小文件 **200+Content-Range**、LFS 206 | 可续传，但状态码语义特殊 |
| 11 | MS HEAD | `HEAD .../resolve/master/{path}` | 200 但**无 Content-Length / Accept-Ranges** | 禁止用 HEAD 探大小 |

---

## 1. 通用约定

### 1.1 请求头与 URL

- `User-Agent` 固定：`ModelDownloadManager/0.1 (+https://github.com/)`（两家均未拒绝该 UA）。
- `Accept: application/json` 用于 API；下载请求不要加 `Accept`。
- Token 头统一 `Authorization: Bearer {token}`，**token 为空时不要发该头**；任何日志/错误信息不得包含 token。
- URL 拼接：`repoId` 中的 `/` 保留为路径分隔符；`remotePath` 按 `/` 分段后逐段 `URL encode`（仓库内可能存在空格/中文文件名）。`{revision}` 同理。
- 下载 client：不设全局超时、`redirect` 跟随上限 10（reqwest 默认）、连接超时 30s。

### 1.2 错误识别总原则

1. 先看 HTTP 状态码；2xx 后再看业务层字段。
2. **不要只看状态码**：ModelScope 的 Range 请求会返回 `200 + Content-Range`（见 4.4）；HF 镜像小文件 Range 被忽略返回 `200` 全量（见 3.5）。
3. 业务错误：HF JSON 通常是 `{"error":"..."}`；ModelScope 是 `{"Success":false,"Code":...,"Message":"..."}`。
4. 401/403 → 「需要 Token / 同意 gated 协议」；404 → 「仓库或文件不存在」；429/5xx → 重试。

### 1.3 时间/大小字段格式

| 来源 | 字段 | 格式 | 后端处理 |
|------|------|------|----------|
| HF | `lastModified`（需 `full=true`/详情） | ISO8601 字符串，如 `"2024-09-25T17:00:57.000Z"` | 原样返回 `lastModified?: string`，或解析后 ISO 输出 |
| HF tree | `size` / `lfs.size` | 字节整数 | `size = lfs ? lfs.size : size` |
| MS 搜索/详情 | `LastUpdatedTime` | Unix **秒**（如 `1791798592`） | `*1000` 转 Unix 毫秒或 ISO8601 |
| MS 文件 | `Size` / `CommittedDate` | 字节 / Unix **秒** | 直接使用 |

---

## 2. HuggingFace

### 2.1 连通性：直连不可用，镜像可用（关键结论）

实测命令与输出：

```powershell
# 直连（curl.exe，Windows 自带）
curl.exe -sS -o NUL -w "status=%{http_code} time=%{time_total} err=%{errormsg}" --max-time 25 "https://huggingface.co/api/models?limit=1"
# => status=000 time=21.253972 err=Failed to connect to huggingface.co:443 after 21253 ms: Could not connect to server

# -4 强制 IPv4 同样失败；DNS 解析结果异常：
Resolve-DnsName huggingface.co -Type A
# => AAAA 2a03:2880:f127:283:face:b00c:0:25de
# => A    157.240.13.8        <-- 该地址属于 Facebook 网段，疑似 DNS 污染
```

`Invoke-WebRequest -TimeoutSec 40` 对 `https://huggingface.co/api/models?...` 全部超时（18:49–18:52 多次复现）。

```powershell
# 镜像
curl.exe -sS -o NUL -w "status=%{http_code} time=%{time_total} ip=%{remote_ip}" --max-time 25 "https://hf-mirror.com/api/models?limit=1"
# => status=200 time=0.416140 ip=160.16.86.14
```

**结论**：
- 本机/本网络（中国大陆）**huggingface.co 直连不可用**，`hfEndpoint` 必须支持镜像；本环境推荐默认值改为 `https://hf-mirror.com`（或启动时 `test_connection` 失败自动切镜像并提示用户）。
- `hf-mirror.com` 使用**与 huggingface.co 完全相同的路径与参数**，差异在下载跳转与小文件 Range（见 3.5）。
- 若用户能直连 HF（海外网络），本文件记录的 API 路径同样适用；仅下载跳转目标不同（直站 302 → `cdn-lfs*.huggingface.co` / `cas-bridge.xethub.hf.co`，**未验证**）。

### 2.2 搜索 `GET /api/models`

```powershell
$u = "https://hf-mirror.com/api/models?search=Qwen&limit=3&sort=downloads&direction=-1&full=true"
Invoke-WebRequest $u -Headers @{'User-Agent'='ModelDownloadManager/0.1'} -SkipHttpErrorCheck
```

实测（18:52）：`status=200`，响应体为 JSON 数组。

**查询参数表**

| 参数 | 取值 | 说明 |
|------|------|------|
| `search` | 关键字（URL 编码） | 搜索仓库 id/描述 |
| `limit` | 1..1000（实测 100/1000 均 200） | 契约上限 50，够用 |
| `sort` | `downloads` / `likes` / `lastModified` / `createdAt` | 实测 `downloads`、`likes` 都可用（`sort=likes&direction=-1` 200） |
| `direction` | `-1` 降序 / `1` 升序 | 与 sort 搭配 |
| `full` | `true` | **必须加**：否则每条缺 `lastModified`、`gated` |
| `cursor` | 上一页 `Link` 中的游标 | 只用于翻页；传非法值 → `400` |
| `page` / `offset` | — | **无效**：实测加 `&page=2`、`&offset=3` 返回与首页完全相同的结果 |

**响应字段 → `RepoSummary` 映射**（`full=true` 时）

| API 字段 | 类型 | 映射 | 说明 |
|----------|------|------|------|
| `id` | string | `RepoSummary.id` | 如 `Qwen/Qwen2.5-7B-Instruct` |
| `downloads` | number | `downloads` | 累计下载 |
| `likes` | number | `likes` | |
| `tags` | string[] | `tags` | 含 `license:...`、`base_model:...`、语言等自动标签；原样保存 |
| `pipeline_tag` | string? | `pipelineTag` | 可能缺失 |
| `lastModified` | ISO8601 string | `lastModified` | 需 `full=true` |
| `gated` | `false` / `"auto"` / `"manual"` | `gated` | 需 `full=true`；实测三种值均出现 |
| `createdAt` / `_id` / `sha` / `author` / `trendingScore` / `siblings` | — | 忽略 | `full=true` 附带，可不用 |

实测响应片段（18:58 原始 JSON，`full=true`）：

```json
{"id":"meta-llama/Llama-3.1-8B-Instruct","downloads":4475436,"gated":"manual",
 "lastModified":"2024-09-25T17:00:57.000Z","pipeline_tag":"text-generation", ...}
```

> 未加 `full=true` 时单条字段为：`_id,id,likes,private,downloads,tags,pipeline_tag,library_name,createdAt,modelId`
> —— **没有 `gated` 和 `lastModified`**，直接映射会导致 RepoSummary 缺字段。

**分页：`Link` 头 cursor（唯一方式）**

实测响应头原文（18:52，已截断中间 cursor 内容）：

```
Link: <https://hf-mirror.com/api/models?search=qwen&limit=3&sort=downloads&direction=-1&cursor=eyIkb3IiOlt7ImRvd25sb2FkcyI6MTA1ODg4NzUsIl9pZCI6eyIkZ3QiOiI2YWE5OWY1NTI4NTk4MjdhOGQ4OWNiOWQifX1d...>; rel="next"
Ratelimit: "api";r=499;t=120
Ratelimit-Policy: "fixed window";"api";q=500;w=300
```

- 只接受 `rel="next"`；无此头 = 没有下一页 → `hasMore=false`。
- **注意镜像坑**：`Link` 里 host 是 `https://huggingface.co`（镜像回源原样透传），直接跟随会再次连不上 huggingface.co。后端必须**把 Link 的 host 重写成配置的 `hfEndpoint`**，只保留 path+query（path 以 `/api/` 开头，校验后使用）。
- `nextCursor`：取 Link 中 `cursor` 参数的值（URL 解码后保存），下一页请求 `&cursor={EscapeDataString(cursor)}`；或直接保存重写后的完整 next URL（契约字段类型允许 string）。
- 非法 cursor 实测：`&cursor=bogus` → `400`（建议视为「游标失效，回到第 1 页」）。

**限流**：镜像返回 `Ratelimit-Policy: 500 req / 300 s`；本次实测未触发 429。后端按 429/5xx 指数退避即可。

**搜索 span 验证**：`GET /api/models?search=Qwen&limit=20&full=true` 响应约 238KB→ 单条约 12KB；契约 `limit<=50` 时单页约 600KB，可接受。

### 2.3 仓库详情 `GET /api/models/{repoId}`

实测（18:52）：`GET https://hf-mirror.com/api/models/meta-llama/Llama-3.1-8B-Instruct` → `200`。

关键字段（原始 JSON 解析后）：

```
id=meta-llama/Llama-3.1-8B-Instruct  gated=manual  lastModified=2024-09-25T17:00:57.000Z
downloads=4463539  likes=8760  private=False  siblings=17  cardData.license=llama3.1
```

- 公开仓库无需 Token；gated 仓库的**元信息也可匿名读取**（`gated` 字段即在此给出）。
- `siblings` 是文件列表但**没有 size**；文件大小必须走 2.4 文件树。
- 404 形态（18:58）：

```
GET /api/models/no-such-org-xyz/no-such-model-123 => 404 {"error":"Repository not found"}
```

### 2.4 文件树 `GET /api/models/{repoId}/tree/{revision}?recursive=true`

实测（18:52/18:58）：

```powershell
GET https://hf-mirror.com/api/models/Qwen/Qwen2.5-7B-Instruct/tree/main?recursive=true
# => 200，14 条，无 Link（条目数不足一页）
```

单条字段与映射：

| API 字段 | 说明 | 映射 |
|----------|------|------|
| `type` | `"file"`（递归模式下实测均为 file） | 只接受 `file`，忽略 `directory` |
| `path` | 仓库内相对路径（分隔符 `/`） | `RepoFile.remotePath` / `path` |
| `size` | 字节 | `size` 的兜底值 |
| `lfs` | 仅 LFS 文件存在：`{oid,size,pointerSize}`（另有 `xetHash`） | **`size = lfs.size` 优先**（与 `size` 相等；`pointerSize` 才是指针 JSON 大小 135B） |
| `oid` / `xetHash` | git/xet 标识 | 忽略（可用于续传校验，非必需） |

`Qwen/Qwen2.5-7B-Instruct` 实测条目（18:58，14 条、总计约 15.2GB）：

```
.gitattributes 1519 | LICENSE 11343 | README.md 6240 | config.json 663
generation_config.json 243 | merges.txt 1671839
model-00001-of-00004.safetensors 3945441440 lfs.size=3945441440
model-00002-of-00004.safetensors 3864726352 lfs.size=3864726352
model-00003-of-00004.safetensors 3864726424 lfs.size=3864726424
model-00004-of-00004.safetensors 3556377672 lfs.size=3556377672
model.safetensors.index.json 27752 | tokenizer.json 7031645
tokenizer_config.json 7305 | vocab.json 2776833
```

**分页**：
- 默认每页 1000 条；超过时响应头出现 `Link: <...&cursor=...>; rel="next"`。
- 本次用 `&limit=5` 实测翻页（同一大仓库，14 条）：

```
GET .../tree/main?recursive=true&limit=5
# 200，5 条；Link: <https://huggingface.co/api/models/.../tree/main?expand=false&recursive=true&limit=5&cursor=ZXlK...>; rel="next"
# 跟随 3 页共 14 条（5+5+4），unique=14
```

- 同样有 **host 重写坑**（Link 里是 huggingface.co），处理方式同 2.2。
- **gated 仓库的文件树**：实测 `GET /api/models/meta-llama/Llama-3.1-8B-Instruct/tree/main?recursive=true` → `200`，18 条、无 Link（19:01 复跑验证）。即**仓库元数据/文件树匿名可读，只有下载会被拒**。后端遇到 401/403 时统一走 gated 提示逻辑即可。
- `revision` 参数：契约默认 `main`；`tree/{revision}` 实测 `main` 可用，其他分支/commit 未测（**未验证**，实现按路径替换即可）。

### 2.5 下载 `GET /{repoId}/resolve/{revision}/{remotePath}`

**小文件（非 LFS，如 config.json 659B）**

```powershell
curl.exe -sS -D - -o NUL --max-redirs 0 "https://hf-mirror.com/Qwen/Qwen2.5-0.5B-Instruct/resolve/main/config.json"
# => HTTP/1.1 307 Temporary Redirect
#    Location: /api/resolve-cache/models/Qwen/Qwen2.5-0.5B-Instruct/<sha>/config.json?%2FQwen%2F...&etag="..."
# 跟随重定向后：200，Content-Length: 659，final host = hf-mirror.com
```

**LFS 大文件（model.safetensors 988,097,824B）**

```powershell
curl.exe -sS -D - -o NUL --max-redirs 0 -H "Range: bytes=0-1023" \
  "https://hf-mirror.com/Qwen/Qwen2.5-0.5B-Instruct/resolve/main/model.safetensors"
# => HTTP/1.1 302 Found
#    Location: https://cas-bridge.xethub.hf.co/xet-bridge-us/...（带 X-Amz-Signature，1 小时过期）
```

本机 curl 只拿到首跳；完整跟随结果用 IWR 实测（18:52）：

| 请求 | 状态 | 响应头/证据 | 结论 |
|------|------|-------------|------|
| `GET .../model.safetensors` + `Range: bytes=0-1023` | **206** | `Content-Range: bytes 0-1023/988097824`、`Content-Length: 1024`、body=1024B | LFS **支持 Range，可续传** |
| 同上 `Range: bytes=1000000-1001023` | **206** | `Content-Range: bytes 1000000-1001023/988097824` | 中段续传正常 |
| `GET .../config.json` + `Range: bytes=0-1023` | **200** | 无 `Content-Range`，body=659B（全量） | **Range 被忽略**（resolve-cache 代理） |
| `GET .../tokenizer.json`（7,031,645B，非 LFS）+ `Range: bytes=0-1023` | **200** | 无 `Content-Range`，body=7,031,645B（全量） | 同上，非 LFS 均不可续传 |

**断点续传实现要求（HF 镜像）**：先发 `Range: bytes={resumeFrom}-`；若返回 `206` + `Content-Range: bytes {start}-{end}/{total}` 且 `start==resumeFrom` → append；若返回 `200`（无 Content-Range）→ 镜像忽略 Range，**必须截断 `.part` 从头写**。契约 5.2 已有该分支，确认可用。

**Accept-Encoding 影响**：本次未实测（保持 `Accept-Encoding: identity` 或关闭自动解压最安全——**未验证**）。下载流式写入时绝不能启用响应自动解压，否则 `Content-Length` 与写入字节数对不上。

**gated 仓库下载（无 Token）**（18:52 实测）：

```powershell
GET https://hf-mirror.com/meta-llama/Llama-3.1-8B-Instruct/resolve/main/config.json
# => status=403
# body: Please enable access to public gated repositories in your fine-grained token settings to view this repository.
```

- 镜像未返回 `X-Error-Code` 头（直站通常会带 `X-Error-Code: gated`，**未验证**）。后端**不要依赖 X-Error-Code**，按 401/403 → 「该仓库需要授权：请在设置中填写 HuggingFace Token，并先在网页端同意许可协议」。
- 带 Token 后 gated 下载行为：**未验证**（本机无 token）。按直站语义：token 需在网页端通过 gated 协议 + token 具备 gated 访问权限，否则仍 401/403。

**404 形态**（18:58）：`GET .../resolve/main/no-such-file-for-probe.xyz` → `404`，body 为纯文本 `Entry not found`。

### 2.6 hf-mirror.com 镜像结论

| 能力 | 结果 |
|------|------|
| `/api/models` 搜索、`/api/models/{repo}` 详情、`/api/models/{repo}/tree/...` | **与官方一致，200 可用** |
| `/{repo}/resolve/...` 下载 | **可用**；小文件 307 → 镜像本地 cache；LFS 302 → `cas-bridge.xethub.hf.co` CDN（presigned URL 1h 过期，不可缓存） |
| LFS Range 续传 | **206 可用** |
| 非 LFS Range | **被忽略（200 全量）** |
| `Link` 头 | 是官方 URL（huggingface.co host），必须重写 |
| gated 下载 | 403 + 英文 body |

---

## 3. ModelScope

### 3.1 搜索 **`PUT /api/v1/dolphin/models`**（关键：不是 GET/POST）

实测（18:55）：

```powershell
$body = '{"PageSize":3,"PageNumber":1,"SortBy":"Default","Target":"","SingleCriterion":[],"Name":"Qwen","Criterion":[]}'
Invoke-WebRequest 'https://www.modelscope.cn/api/v1/dolphin/models' -Method PUT -Body $body `
  -ContentType 'application/json' -Headers @{'User-Agent'='ModelDownloadManager/0.1'} -SkipHttpErrorCheck
# => 200，41,975 bytes（3 条）
```

**候选端点实测结果（18:50/18:55）**

| 方法/路径 | 状态 | 结论 |
|-----------|------|------|
| `PUT /api/v1/dolphin/models` | **200** | ✅ 唯一可用搜索端点 |
| `POST /api/v1/dolphin/models` | 404 | `404 page not found` |
| `GET /api/v1/dolphin/models?...` | 404 | |
| `POST /api/v1/dolphin/models/search` / `POST /api/v1/models/search` / `GET /api/v1/models/search?...` | 404 | 均不存在 |
| `GET /api/v1/models`（含 `?PageSize=...&PageNumber=...&SortBy=...`） | 404 | 列表路由不存在 |
| `POST /api/v1/models` | 404 | |

**请求体（完整）**

```json
{
  "PageSize": 20,
  "PageNumber": 1,
  "SortBy": "Default",
  "Target": "",
  "SingleCriterion": [],
  "Name": "Qwen",
  "Criterion": []
}
```

- 必填/关键：`PageSize`、`PageNumber`、`Name`；其余可省略（实测最小 body `{"PageSize":2,"PageNumber":1,"Name":"qwen"}` 也 200）。
- `SortBy`：**只接受 `"Default"`**；`"Downloads"`、`"Stars"`、`"DownloadCount"`、`"StarCount"`、`"LastUpdated"`、`"Newest"`、`"Hot"`、`"downloads"`、`"stars"` 全部 **400**：

```
{"Code":10010202002,"Message":"参数错误，信息：Key: 'ListModelsParameter.Sort.SortBy' Error:Field validation for 'SortBy' failed on the 'oneof' tag",...}
```

→ 后端**不要依赖服务端按下载量排序**；需要下载量排序时只能本地排序（或扩展研究：Sort 对象/枚举值未找到，**未验证**）。

**响应结构**

```
Code=200, Success=true, Message="success", RequestId=...
Data:
  FiledAgg   (聚合筛选信息: language/category/task 等计数)
  Model:
    TotalCount = 28558
    Models[]   (每条 12~16KB 巨型对象)
  Source / Target
```

**字段映射（`Data.Model.Models[]` → `RepoSummary`）**

| API 字段 | 类型 | 映射 | 备注 |
|----------|------|------|------|
| `Path` + `"/"` + `Name` | string | `id` | 如 `Qwen/Qwen2.5-7B-Instruct` |
| `Downloads` | number | `downloads` | 实测 `42961` 等 |
| `Stars` | number | `likes` | ModelScope 叫 Stars，语义=收藏/点赞 |
| `LastUpdatedTime` | Unix **秒** | `lastModified` | 如 `1791798592`；`*1000` 或转 ISO8601 |
| `Tags` | string[] | `tags` | 可能为空数组 |
| `Tasks[]` | object[]：`{Id,Name,ChineseName,DomainName,...}` | `pipelineTag = Tasks[0].Name` | 无任务时为空数组 |
| `License` | string | `license`（详情用） | 如 `apache-2.0` |
| `ChineseName` | string | 可用于展示 | 可能为空 |
| `Description` | string | 可作描述 | 搜索列表里**常为空**（实测 descLen=0） |
| `Visibility` | number | 私有判断 | `5` = 公开（实测） |
| `Id` | number | 内部数字 id，**不要当 id** | |
| `Libraries` / `Frameworks` / `Architectures` | string[] | 可选 | 如 `pytorch/diffusers/safetensors` |
| `AigcAttributes`,`Organization`,`MuseInfo`,`ModelDetail`,`Support*` 等 | — | **忽略** | 单条响应巨大，禁止整体反序列化到强类型 |

实测单条摘要（18:55，`Name+Path` 拼 id）：

```
id=Qwen/Qwen-Image-2.1-Turbo downloads=42961 stars=392 lastUpdated=1791798592
tasks=text-to-image-synthesis license=other visibility=5
id=Qwen/Qwen3.8-Flash-Next downloads=104857 stars=1539 chineseName=千问3.8-Flash-Next
```

**分页**

- `PageNumber` 从 1 起，`PageSize` 自定义；实测 `PageNumber=2&PageSize=3` 返回不同 3 条。
- 总量 `Data.Model.TotalCount`（实测 Qwen 关键字 28558；空 Name=282288）。
- `hasMore = PageNumber * PageSize < TotalCount`（取严格小于，最后一页可能不满）。
- 契约 `search_repos` 的 `page` 直接映射 `PageNumber`，`limit` 映射 `PageSize`；ModelScope 不使用 `nextCursor`。

**性能提示（必看）**：搜索响应**非常大**：`PageSize=3` → 41,975B；`PageSize=20` → **243,484B（约 238KB）**，即约 12KB/条（每条约 16KB 的完整模型对象，含 Organization/MuseInfo/ModelDetail 等）。契约 `limit<=50` 时单页可能 ~600KB~800KB，后端建议：
- 解析时只取需要的字段（serde `Deserialize` 用 `#[serde(default)]` 的部分结构即可，勿强类型整对象）；
- 前端默认 limit 用 20，并在 UI 提示加载慢；
- 如需更小响应，可后续研究 `Target`/`SingleCriterion` 过滤（本次未验证字段选择能力）。

**中文搜索**（18:55 实测均 200）：

| Name | TotalCount | 首条 id |
|------|-----------|---------|
| `通义` | 1411 | `Wan-AI/Wan2.1-T2V-1.3B` |
| `中文` | 890 | `iic/speech_campplus_sv_zh-cn_16k-common` |
| `Qwen` | 28558 | `Qwen/Qwen-Image-2.1-Turbo` |
| 空字符串 | 282288 | `deepseek-ai/DeepSeek-V4.1-Flash-1017` |

### 3.2 仓库详情 `GET /api/v1/models/{repoId}`

实测（18:55）：`GET https://www.modelscope.cn/api/v1/models/Qwen/Qwen2.5-7B-Instruct` → `200`。

```
Data.Name=Qwen2.5-7B-Instruct  Data.Path=Qwen  downloads=7336269  stars=568
License=apache-2.0  Revision=master  Visibility=5  LastUpdatedTime=1741335540
Tags/Libraries/ChineseName/Description 同 3.1
```

**错误形态**（18:55）：不存在的仓库 → `404`：

```json
{"Code":10010205001,"Message":"获取模型信息失败，信息：record not found","RequestId":"...","Success":false}
```

> 私有仓库的 401/403 具体形态本次未验证（无私有仓库样本）；实现时：404/401/403 都按 `Success=false` + `Message` 展示，并提示检查 Token。

### 3.3 文件列表 `GET /api/v1/models/{repoId}/repo/files?Recursive=true`

实测（18:50，`Qwen/Qwen2.5-0.5B-Instruct`）：`200`，4,557B。

**响应结构**

```
Code=200, Success=true, Message="success", RequestId=...
Data:
  Files[]            <-- 全部条目（文件 + 目录）
  IsVisual
  LatestCommitter
```

单个条目字段（实测原始 JSON）：

```json
{"CommitMessage":"Upload folder using huggingface_hub","CommittedDate":1726523690,
 "CommitterName":"ai-modelscope","InCheck":false,"IsLFS":true,"Mode":"33188",
 "Name":"model.safetensors","Path":"model.safetensors",
 "Revision":"13448952dbdab7a1627d0680ecd207535d889a23",
 "Sha256":"fdf756fa...","Size":988097824,"Type":"blob"}
```

| API 字段 | 说明 | 映射 |
|----------|------|------|
| `Type` | `"blob"`（文件）/ `"tree"`（目录） | **只保留 `blob`**；`tree` 项 `Size=0`，必须过滤 |
| `Name` | 文件名（最后一段） | `RepoFile.name` |
| `Path` | 仓库内相对路径 | `RepoFile.path`（下载时直接用，逐段 URL 编码） |
| `Size` | 字节（LFS 文件为真实大小） | `RepoFile.size` |
| `Sha256` | 文件内容 sha256（LFS 为对象 sha） | 可选，校验/去重 |
| `Revision` | 该文件所在 commit sha | 可选 |
| `IsLFS` | bool | 可选；实测 `Size` 已是真实大小，**无需再找 lfs.size** |
| `Mode` / `CommittedDate` / `CommitMessage` / `CommitterName` | — | 忽略（`CommittedDate` 为 Unix 秒） |

**大仓库表现**（18:55）：`Qwen/Qwen2.5-7B-Instruct` → `200`，blobs=15，`totalBlobBytes=15,242,807,272`；`deepseek-ai/DeepSeek-R1-Distill-Qwen-1.5B` → blobs=10 + 1 个 `tree` 目录（`figures`，Size=0），总 3,562,046,176B。

- 接口**一次返回全部文件**（本批仓库仅 10~15 个文件）；分页参数未发现（**未验证**超大文件数仓库，例如 1000+ 文件的仓库响应体大小）。实现时加响应体上限保护（如 20MB/次）即可。
- `Revision` 查询参数：实测 `&Revision=master` 与不传结果一致（默认 master）。
- **顶层 `Data` 无 Revision 字段**（实测为空），`RepoDetail.revision` 直接用默认 `"master"`（或用户传入）。

**错误形态**（18:55）：不存在仓库 → `404`：

```json
{"Code":10010205001,"Message":"获取模型目录树失败，信息：record not found","RequestId":"...","Success":false}
```

→ 契约要求的「`Success:false` 时用 `Message` 作为错误信息」实测成立。

### 3.4 下载 `GET /models/{repoId}/resolve/{revision}/{remotePath}`

revision 默认 `master`。URL 模板：`{msEndpoint}/models/{repoId}/resolve/{revision}/{encodedRemotePath}`。

**非 LFS 小文件（config.json 659B）**（18:55）：

```
GET https://www.modelscope.cn/models/Qwen/Qwen2.5-0.5B-Instruct/resolve/master/config.json
=> 200（直接返回，无跳转），Content-Type: application/json，rawlen=659，
   final=https://www.modelscope.cn/models/...（未离开主站）
```

**LFS 大文件（model.safetensors）**：

```
curl.exe -sS -D - -o NUL --max-redirs 0 -H "Range: bytes=0-1023" \
  "https://www.modelscope.cn/models/Qwen/Qwen2.5-0.5B-Instruct/resolve/master/model.safetensors"
# => HTTP/1.1 302 Found
#    Location: https://cdn-lfs-cn-1.modelscope.cn/prod/lfs-objects/fd/f7/...?filename=model.safetensors
#              &namespace=Qwen&repository=Qwen2.5-0.5B-Instruct&revision=master&tag=model
#              &auth_key=1793703274-...（带过期签名，不要缓存该 URL）
```

跟随 302 后的 Range 实测（18:50/18:55）：

| 请求 | 状态 | 响应头/证据 | 结论 |
|------|------|-------------|------|
| LFS `Range: bytes=0-1023`（988,097,824B 文件） | **206** | `Content-Range: bytes 0-1023/988097824`、`Content-Length: 1024`、body=1024B | 支持续传 |
| LFS `Range: bytes=1048576-1049599` | **206** | `Content-Range: bytes 1048576-1049599/988097824` | 中段续传正常 |
| LFS `Range: bytes=1048576-1049599`（7B 分片 3,945,441,440B） | **206** | `Content-Range: bytes 1048576-1049599/3945441440` | 分片文件正常 |
| **非 LFS** `Range: bytes=100-199`（config.json 659B） | **200（不是 206！）** | `Content-Range: bytes 100-199/659`、`Content-Length: 100`、body=100B | **状态码是 200 但确实返回了部分内容** |
| 非 LFS `Range: bytes=0-1023`（config.json） | **200** | `Content-Range: bytes 0-658/659`、CL=659 | 同上（整文件） |
| 非 LFS `Range: bytes=0-1023`（tokenizer.json 7,031,645B） | **200** | `Content-Range: bytes 0-1023/7031645`、CL=1024、body=1024B | **可续传，但状态码 200** |

**⚠️ 后端续传核心规则（必须照此实现）**：
1. 发 `Range: bytes={resumeFrom}-` 后，**先读 `Content-Range`，不要先判状态码**。
2. `Content-Range: bytes {start}-{end}/{total}` 存在且 `start == resumeFrom` → 视为续传成功，append 写入（无论状态码是 200 还是 206）。
3. 200 且**无** `Content-Range` → 服务器忽略 Range（HF 镜像非 LFS），截断 `.part` 从头写。
4. 416 → 按契约 5.2 处理（`Content-Range: bytes */N` 且 N==resumeFrom → 已完成）。
5. `Content-Range` 的 `total` 覆盖文件列表大小（可修复列表中 size 不准的情况）。

**HEAD 陷阱**（18:55 实测）：`HEAD .../resolve/master/model.safetensors` → `200`，**无 `Content-Length`、无 `Accept-Ranges`**，且不跳转。→ **禁止用 HEAD 探测文件大小或是否支持 Range**；大小用 3.3 文件列表。

**Token 头**（18:50/18:55 实测）：
- `Authorization: Bearer <非法假 token>` 访问**公开**仓库的 files / resolve → 均 `200`（Token 头格式被接受/忽略）。→ 说明 MS 允许在匿名可用端点上携带 Token；私有仓库需要真实 Token（401/403 形态**未验证**）。
- 本机无真实 MS token，私有仓库/需要授权的模型行为未实测。

**404 形态**（19:00 实测）：`GET .../resolve/master/no-such-file-for-probe.xyz` → `404`：

```json
{"Code":10990101007,"Message":"获取模型文件失败，文件内容为空","RequestId":"...","Success":false}
```

---

## 4. Token / 鉴权规范

| 来源 | 头 | 何时发送 | gated/私有行为 |
|------|----|----------|----------------|
| HF | `Authorization: Bearer {hfToken}` | `hfToken` 非空时**所有 API 与下载请求**都带 | 详情可匿名读；下载 gated 返回 401/403，需 Token 且网页端同意协议（直站语义，镜像实测 403 英文 body） |
| MS | `Authorization: Bearer {msToken}` | `msToken` 非空时所有请求带 | 公开仓库带非法 token 仍 200；私有仓库需真实 token（401/403 形态**未验证**，错误信息取 `Message`） |

- 错误提示模板（中文，不泄露 token）：
  - HF 401/403：「该仓库需要授权：请在设置中填写 HuggingFace Token，并先在网页端同意许可协议。」
  - MS 401/403/404（Success=false）：「ModelScope 返回：{Message}。请检查 Token 或仓库 id。」
- 只在 `test_connection` 成功信息里提示「已连接 {source}」，绝不回显 token。

---

## 5. 推荐测试资源（实测确认存在）

### 5.1 小文件（<10MB，下载冒烟/校验）

| 用途 | 来源 | URL | 大小（实测） |
|------|------|-----|--------------|
| 最小下载 + JSON 校验 | HF 镜像 | `https://hf-mirror.com/Qwen/Qwen2.5-0.5B-Instruct/resolve/main/config.json` | **659 B** |
| 最小下载 + JSON 校验 | ModelScope | `https://www.modelscope.cn/models/Qwen/Qwen2.5-0.5B-Instruct/resolve/master/config.json` | **659 B** |
| 中等文件（~7MB，进度条/限速） | HF 镜像 | `.../Qwen/Qwen2.5-0.5B-Instruct/resolve/main/tokenizer.json` | **7,031,645 B** |
| 中等文件（~7MB） | ModelScope | `https://www.modelscope.cn/models/Qwen/Qwen2.5-0.5B-Instruct/resolve/master/tokenizer.json` | **7,031,645 B** |
| 文本小文件 | 两家 | `.../LICENSE` | 11,343 B / 1,064 B（按仓库） |
| 配置 | 两家 | `.../generation_config.json` | 242 / 243 B |

### 5.2 断点续传/大文件测试

| 来源 | URL | 大小 | 实测行为 |
|------|-----|------|----------|
| HF 镜像 | `https://hf-mirror.com/Qwen/Qwen2.5-0.5B-Instruct/resolve/main/model.safetensors` | 988,097,824 B | LFS → 206 + Content-Range ✅ |
| ModelScope | `https://www.modelscope.cn/models/Qwen/Qwen2.5-0.5B-Instruct/resolve/master/model.safetensors` | 988,097,824 B | 302 → CDN → 206 ✅ |
| HF 镜像 | `.../Qwen/Qwen2.5-7B-Instruct/resolve/main/model-00001-of-00004.safetensors` | 3,945,441,440 B | LFS → 206 ✅ |
| ModelScope | `https://www.modelscope.cn/models/Qwen/Qwen2.5-7B-Instruct/resolve/master/model-00001-of-00004.safetensors` | 3,945,441,440 B | 302 → CDN → 206 ✅ |
| ModelScope（小文件续传语义） | `.../Qwen/Qwen2.5-0.5B-Instruct/resolve/master/tokenizer.json` | 7,031,645 B | Range→200 + Content-Range（验证 4.4 特殊逻辑）✅ |

续传冒烟建议：先下 1MB，再 `Range: bytes=1048576-` 验证 `Content-Range` 从 1048576 开始且 `total` 正确。

### 5.3 热门中文/常用模型仓库（两家同名，均实测 200）

| repoId | HF 镜像（19:00 实测） | ModelScope（19:00 实测） | 说明 |
|--------|----------------------|--------------------------|------|
| `Qwen/Qwen2.5-7B-Instruct` | 详情 200 `gated=false`；tree 200：14 文件，合计 **15,242,807,270 B** | 详情 200（Downloads=7,336,276 / Stars=568 / License=apache-2.0）；files 200：blobs=15，合计 **15,242,807,272 B** | 主推荐大仓库（分片 4×~3.9GB） |
| `deepseek-ai/DeepSeek-R1-Distill-Qwen-1.5B` | 详情 200 `gated=false`；tree 200：10 文件，合计 **3,562,046,103 B** | 详情 200（Downloads=2,350,341 / Stars=360）；files 200：blobs=10，合计 **3,562,046,176 B** | 中文热门，体积适中 |
| `BAAI/bge-large-zh-v1.5` | 详情 200 `gated=false`；tree 200：13 文件，合计 **1,302,803,319 B** | 详情 200（Downloads=2,764,182 / Stars=157）；files 200 | 中文 embedding |

> 两家同名仓库的合计大小可能相差几字节（例如 7B：HF 15,242,807,270 vs MS 15,242,807,272，来自 config.json 等文件版本差异），`totalSize` 以各自文件列表为准，不要跨源复用。
> 所有仓库均**无需 Token** 即可读取元数据与公开文件。

---

## 6. 文件分类扩展名建议（给后端 `util::classify_file`）

当前 `docs/IPC-CONTRACT.md` 第 2 节的清单基本正确，实测仓库中出现/易遗漏的点如下（**建议 Lead 更新契约后实现**）：

### 6.1 权重 weight（按优先级）

1. **先判断分片索引**：文件名以 `.safetensors.index.json`、`.bin.index.json`、`.pt.index.json` 结尾 → **weight**（不能被 `.json` 规则吞掉）。
2. 常见权重扩展名：`.safetensors`、`.bin`、`.pt`、`.pth`、`.ckpt`、`.gguf`、`.onnx`、`.h5`、`.keras`、`.msgpack`、`.npz`、`.npy`、`.engine`、`.plan`、`.tflite`、`.mlmodel`、`.mlpackage`、`.ot`、`.pkl`、`.pickle`、`.joblib`、`.sft`、`.nemo`、`.mindir`、`.om`、`.rknn`、`.onnx_data`（外部权重）。
3. 追加建议：`.onnx_data`、`.npy`、`.keras`、`.pickle`、`.joblib`、`.nemo`、`.sft`、`.mindir`、`.om`、`.plan`（TensorRT）。`.model` 有歧义（SentencePiece 文本模型 vs XGBoost 二进制），契约现列为 config，本次维持 config 也可接受，**建议按扩展名 + 文件大小兜底**。

### 6.2 配置 config

现有：`.json .yaml .yml .txt .md .model .tiktoken .py .jinja .cfg .ini .toml`
补充：`.spm`（SentencePiece）、`.vocab`、`.merges.txt`（`.txt` 已覆盖）、`.args.json`/所有普通 `.json`、`.template`、`.tmpl`、`.jsonl`（数据配置类）。注意顺序：先判 `.index.json`（权重），再判 `.json`（配置）。

### 6.3 其它 other

`.gitattributes`、`.md` 之外的图片/压缩包（`.png/.jpg/.zip/.tar/.gz`）、`.txt` 之外的说明文件、`README.md`（config，已覆盖）、`.onnx` 旁边的 `.onnx_data`（weight）、`figure/` 目录（MS `type=tree`，过滤掉）。UI 分类展示失败不影响下载，允许未知扩展名归 `other`。

---

## 7. 后端必须知道的坑清单（可直接照抄进实现）

1. **HF 直连在本环境不可用**：`hfEndpoint` 默认值若为 `https://huggingface.co`，真实用户（国内网络）会全超时。建议：设置页默认展示 `https://hf-mirror.com` 或启动时探测直连失败后提示切换镜像；`test_connection` 用镜像验证。
2. **HF `Link` 头 host 重写**：搜索与 tree 的 `rel="next"` URL 里 host 是 `huggingface.co`。拼 next 请求时必须替换为配置 endpoint（只取 path+query），否则镜像用户翻页立刻失败。
3. **HF 搜索必须 `&full=true`**：否则 `lastModified`/`gated` 字段缺失，RepoSummary 无法填满。
4. **HF `page`/`offset` 无效**，只能 cursor；非法 cursor 返回 400 → 回第 1 页。
5. **HF tree 用 `lfs.size` 优先**；递归模式条目 `type=file`；分页同样 Link+cursor+host 重写。
6. **HF 非 LFS 小文件不支持 Range**（200 全量）→ 触截断重下；LFS 才 206。
7. **HF gated**：详情可匿名读（`gated:"manual"/"auto"`），下载无 Token 401/403；错误文案固定中文提示，不要依赖 `X-Error-Code`（镜像没有）。
8. **MS 搜索是 PUT**，GET/POST 都 404；body 至少 `{PageSize,PageNumber,Name}`；`SortBy` 只能 `"Default"`。
9. **MS 搜索响应巨大**（约 12~16KB/条）：只反序列化需要的字段；契约 limit 建议默认 20。
10. **MS 翻页**用 PageNumber/PageSize + TotalCount 计算 hasMore；不使用 nextCursor。
11. **MS 文件列表**过滤 `Type=="blob"`；用 `Size`/`Path`/`Name`；`tree` 项 Size=0 必须跳过。
12. **MS Range 语义特殊**：小文件 `200 + Content-Range`，LFS `206` → 续传判断以 `Content-Range` 为准（规则见 4.4）。
13. **MS HEAD 无效**（200 无 Content-Length），不要用它探测大小/续传支持。
14. **MS 下载 302 到 CDN 的 URL 带 auth_key 会过期**：不要缓存下载 URL，每次下载/续传重新走 resolve（缓存 URL 会在 1 小时后 403）。
15. **错误信息**：MS 一律先判 `Success==false` 后用 `Message`；HF 用 `{"error":...}` 或纯文本。
16. **revision 默认值**：HF `main`、MS `master`；URL 中 revision 也需 encode。
17. **Token 只在非空时发**；msToken/hfToken 分开存；日志与错误信息不得含 token（本文件不记录任何 token 值）。

---

## 8. 探测脚本用法

```powershell
# HF 镜像全量探测（搜索/详情/tree/Link 翻页/resolve+Range/gated/404/限流头）
pwsh -File scripts/probe-hf.ps1

# 指定直站（会先打印直连可达性，然后照常探测；本机直站会 [FAIL]）
pwsh -File scripts/probe-hf.ps1 -Endpoint https://huggingface.co

# 带 Token（只验证是否携带，不打印 token）
$env:HF_TOKEN = 'hf_xxx'; pwsh -File scripts/probe-hf.ps1

# ModelScope 全量探测（PUT 搜索/翻页/排序错误/中文搜索/详情/files/resolve+Range/HEAD/Token/错误形态）
pwsh -File scripts/probe-modelscope.ps1

$env:MS_TOKEN = 'ms_xxx'; pwsh -File scripts/probe-modelscope.ps1
```

脚本输出约定：每个探测一行 `[PASS]/[FAIL] 名称: 状态/关键字段`，末尾打印 `== SUMMARY ==` 汇总与关键结论；失败数 >0 时退出码 1。默认只探测镜像/ModelScope，不耗时探测不可达的 huggingface.co（仅做一次 8s 超时的可达性检查）。

### 8.1 复跑验证（2026-11-03 19:01，Windows 11 / PowerShell 7.6.9）

| 脚本 | 结果 | 耗时 |
|------|------|------|
| `pwsh -File scripts/probe-hf.ps1` | 全部 `[PASS]`，`failures=0`，退出码 0；直连 huggingface.co 超时为环境事实，仅提示不判失败 | 28.7s |
| `pwsh -File scripts/probe-modelscope.ps1` | 全部 `[PASS]`，`failures=0`，退出码 0 | 5.4s |

复跑注意事项：
- 搜索结果/下载量是动态的（如 MS `TotalCount` 28558 ↔ 28559、下载量变化），以当次响应为准，不影响契约字段。
- HF 脚本一次约 29s（含 8s 直连探测、~1MB LFS Range、tree 翻页）；MS 脚本约 5s。
- 脚本内探测的仓库/文件均可替换为 `-Repo`/`-BigRepo`/`-Query` 等参数，不影响结论。

实测时间轴（本次）：

| 时间（+08:00） | 实测内容 | 结果 |
|----------------|----------|------|
| 18:49–18:52 | HF 直连 IWR/curl；hf-mirror search/tree/gated/resolve | 直连全超时；镜像 200/403/206 |
| 18:50 | MS files / 搜索候选 POST/GET / resolve Range | files 200；搜索候选全 404；Range 200+CR |
| 18:52–18:55 | MS 搜索 PUT、详情、HEAD、Token | PUT 200（total 28558）；HEAD 200 无 CL |
| 18:55–18:59 | 排序枚举、翻页、中文搜索、HF full=true/Link 翻页/404/limit | 见上文各节 |

## 9. 未验证 / 疑点（实现时注意）

1. **huggingface.co 直站**的所有响应特征（302 目标、`X-Error-Code`、Range 对非 LFS 是否同样忽略）——本机不可达，无法验证；镜像行为已按上述记录。海外用户直连时若发现差异，以本文件 API 路径为准，下载跳转按「跟随任意 302/307，Range 后按 Content-Range 判断」实现即可兼容。
2. HF tree 默认「每页 1000 条」来自官方行为，本次用 `limit=5` 验证了翻页机制，未找 >1000 文件的模型仓库验证默认页大小。
3. HF 带真实 Token 下载 gated 仓库的完整链路（含网页授权后）。
4. MS 私有仓库的 401/403 响应形态（无样本）；建议后端把 401/403/404 都走 `Success=false + Message` 分支。
5. MS 超大文件数仓库的文件列表是否分页/响应上限（本批最大 15 个文件）。
6. MS 搜索的 `Target`/`SingleCriterion`/`Sort` 对象过滤能力，以及合法排序枚举值（只确认 `Default`）。
7. HF 镜像小文件 Range 被忽略的**大小阈值**（659B 与 7MB 非 LFS 都被忽略，LFS 均支持）；实现按 `Content-Range` 判别即可，不依赖阈值。
8. `Accept-Encoding` 对下载 `Content-Length` 的影响未实测；下载流应禁用自动解压/发送 identity。
