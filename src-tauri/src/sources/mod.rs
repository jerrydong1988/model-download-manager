//! 数据源层：仓库搜索 / 文件列表 / 下载 URL 构造。
//!
//! 全部为纯 `async` 函数，签名形如
//! `pub async fn search(client: &reqwest::Client, settings: &Settings, query: &SearchQuery) -> Result<RepoSearchPage, String>`，
//! 不依赖 `tauri::AppHandle`，可被单元测试 / example / mock server 直接调用。

pub mod huggingface;
pub mod modelscope;

use percent_encoding::{utf8_percent_encode, AsciiSet, CONTROLS};

use crate::models::{RepoDetail, RepoSearchPage, RevisionList, SearchQuery, Settings, Source};

/// URL 路径段内需要转义的 ASCII 字符（字母数字与 `-._~` 之外的危险字符）。
const PATH_SEGMENT: &AsciiSet = &CONTROLS
    .add(b' ')
    .add(b'"')
    .add(b'<')
    .add(b'>')
    .add(b'`')
    .add(b'#')
    .add(b'?')
    .add(b'{')
    .add(b'}')
    .add(b'%')
    .add(b'\\')
    .add(b'^')
    .add(b'|')
    .add(b'[')
    .add(b']');

/// 将仓库内路径按 `/` 分段做百分号转义（保留分隔符）。
pub fn encode_path(path: &str) -> String {
    path.split('/')
        .map(|segment| utf8_percent_encode(segment, PATH_SEGMENT).to_string())
        .collect::<Vec<_>>()
        .join("/")
}

/// 当前设置下某数据源的端点（已去除尾部 `/`）。
pub fn endpoint(settings: &Settings, source: Source) -> &str {
    match source {
        Source::Huggingface => settings.hf_endpoint.trim_end_matches('/'),
        Source::Modelscope => settings.ms_endpoint.trim_end_matches('/'),
    }
}

/// 取某数据源的 token（空字符串视为未配置）。
pub fn auth_token(settings: &Settings, source: Source) -> Option<String> {
    let token = match source {
        Source::Huggingface => settings.hf_token.trim(),
        Source::Modelscope => settings.ms_token.trim(),
    };
    if token.is_empty() {
        None
    } else {
        Some(token.to_string())
    }
}

/// 给请求附加 `Authorization: Bearer`（无 token 时原样返回）。
pub fn with_auth(
    request: reqwest::RequestBuilder,
    settings: &Settings,
    source: Source,
) -> reqwest::RequestBuilder {
    match auth_token(settings, source) {
        Some(token) => request.bearer_auth(token),
        None => request,
    }
}

/// 在 URL 上追加 query 参数（自动转义）。
pub fn url_with_query(base: &str, params: &[(&str, &str)]) -> Result<String, String> {
    let mut url = reqwest::Url::parse(base).map_err(|e| format!("接口地址无效：{e}"))?;
    {
        let mut pairs = url.query_pairs_mut();
        for (key, value) in params {
            pairs.append_pair(key, value);
        }
    }
    Ok(url.to_string())
}

/// 下载 URL：只允许两个固定来源模板（契约 §6 / §8）。
pub fn download_url(
    settings: &Settings,
    source: Source,
    repo_id: &str,
    revision: &str,
    remote_path: &str,
) -> String {
    let base = endpoint(settings, source);
    let repo = encode_path(repo_id);
    let revision = encode_path(revision);
    let remote = encode_path(remote_path);
    match source {
        Source::Huggingface => format!("{base}/{repo}/resolve/{revision}/{remote}"),
        Source::Modelscope => format!("{base}/models/{repo}/resolve/{revision}/{remote}"),
    }
}

/// 搜索仓库（命令 2）。
pub async fn search(
    client: &reqwest::Client,
    settings: &Settings,
    query: &SearchQuery,
) -> Result<RepoSearchPage, String> {
    match query.source {
        Source::Huggingface => huggingface::search(client, settings, query).await,
        Source::Modelscope => modelscope::search(client, settings, query).await,
    }
}

/// 获取仓库详情 / 文件列表（命令 3）。
pub async fn get_repo_detail(
    client: &reqwest::Client,
    settings: &Settings,
    source: Source,
    repo_id: &str,
    revision: Option<&str>,
) -> Result<RepoDetail, String> {
    match source {
        Source::Huggingface => huggingface::detail(client, settings, repo_id, revision).await,
        Source::Modelscope => modelscope::detail(client, settings, repo_id, revision).await,
    }
}

/// 命令 21：仓库可下载 revision 列表（HF refs；ModelScope 尽力，失败返回空数组）。
pub async fn list_revisions(
    client: &reqwest::Client,
    settings: &Settings,
    source: Source,
    repo_id: &str,
) -> Result<RevisionList, String> {
    match source {
        Source::Huggingface => huggingface::list_revisions(client, settings, repo_id).await,
        Source::Modelscope => modelscope::list_revisions(client, settings, repo_id).await,
    }
}

/// 数据源测试连接（命令 18）：读取固定仓库的文件列表。
pub async fn test_connection(
    client: &reqwest::Client,
    settings: &Settings,
    source: Source,
) -> Result<String, String> {
    const TEST_REPO: &str = "Qwen/Qwen2.5-0.5B-Instruct";
    let detail = get_repo_detail(client, settings, source, TEST_REPO, None).await?;
    Ok(format!(
        "{} 连接成功（测试仓库 {}，读取到 {} 个文件）",
        source.label(),
        TEST_REPO,
        detail.files.len()
    ))
}

/// HTTP 状态码 → 中文用户错误（不包含 token；URL 统一脱敏）。
pub fn map_http_error(source: Source, status: reqwest::StatusCode, context: &str) -> String {
    let message = match status.as_u16() {
        401 | 403 => match source {
            Source::Huggingface => {
                "该仓库需要授权：请在设置中填写 HuggingFace Token，并先在网页端同意许可协议"
                    .to_string()
            }
            Source::Modelscope => {
                "无权访问该仓库：请在设置中填写 ModelScope Token，并确认已同意仓库许可".to_string()
            }
        },
        404 => format!("{context}：仓库或文件不存在（HTTP 404）"),
        429 => format!("{context}：请求过于频繁（HTTP 429），请稍后重试"),
        code if code >= 500 => format!("{context}：服务端错误（HTTP {code}），请稍后重试"),
        code => format!("{context}：请求失败（HTTP {code}）"),
    };
    crate::util::redact_urls(&message)
}

/// 网络错误 → 中文用户错误（URL query 脱敏，避免泄漏 CDN 预签名参数）。
pub fn map_network_error(context: &str, error: reqwest::Error) -> String {
    crate::util::redact_urls(&format!(
        "{context}：网络请求失败（{error}），请检查网络或代理设置"
    ))
}

/// 消费响应：状态码非 2xx 时返回中文错误，否则解析 JSON。
pub async fn send_json(
    source: Source,
    context: &str,
    response: reqwest::Response,
) -> Result<serde_json::Value, String> {
    let status = response.status();
    if !status.is_success() {
        return Err(map_http_error(source, status, context));
    }
    response
        .json::<serde_json::Value>()
        .await
        .map_err(|e| format!("{context}：解析响应失败（{e}）"))
}

/// 解析 `Link: <...>; rel="next"` 响应头，返回候选 URL（尚未做同源校验）。
pub fn parse_next_link(headers: &reqwest::header::HeaderMap) -> Option<String> {
    for value in headers.get_all(reqwest::header::LINK).iter() {
        let Ok(text) = value.to_str() else { continue };
        for part in text.split(',') {
            let part = part.trim();
            let is_next = part.contains("rel=\"next\"") || part.contains("rel=next");
            if !is_next {
                continue;
            }
            if let (Some(start), Some(end)) = (part.find('<'), part.find('>')) {
                if start < end {
                    return Some(part[start + 1..end].to_string());
                }
            }
        }
    }
    None
}

/// 分页链接同源校验 + 重写（契约 §6 / Lead 实测）。
///
/// HD 镜像（hf-mirror.com）返回的 `Link rel=next` 指向官方 host
/// （`https://huggingface.co/api/models?...`）。为同时保证镜像可用与防 SSRF：
/// - 只接受 host ∈ `{当前 endpoint host, "huggingface.co"}` 的 URL；
/// - scheme 必须为 https（本地 http 镜像端点例外，与端点同协议）；
/// - 路径必须以 `/api/` 开头，禁止 userinfo、非默认端口与 fragment；
/// - 通过后**总是改写为「当前 endpoint origin + 原 path/query」**再请求。
///
/// 返回可直接请求的 URL；不合法返回 `None`（调用方应停止翻页）。
pub fn validate_api_next_url(candidate: &str, endpoint: &str) -> Option<String> {
    let base = reqwest::Url::parse(endpoint).ok()?;
    let url = reqwest::Url::parse(candidate).ok()?;

    let scheme = url.scheme();
    if scheme != "https" && scheme != base.scheme() {
        return None;
    }
    let base_host = base.host_str()?;
    let candidate_host = url.host_str()?;
    let host_allowed = candidate_host.eq_ignore_ascii_case(base_host)
        || candidate_host.eq_ignore_ascii_case("huggingface.co");
    if !host_allowed {
        return None;
    }
    if url.port_or_known_default() != base.port_or_known_default() {
        return None;
    }
    if !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    if !url.path().starts_with("/api/") {
        return None;
    }
    if url.fragment().is_some() {
        return None;
    }

    // 总是改写为当前端点 origin（防 SSRF；镜像模式下去掉官方 host）。
    let mut rewritten = base;
    rewritten.set_path(url.path());
    rewritten.set_query(url.query());
    Some(rewritten.to_string())
}
