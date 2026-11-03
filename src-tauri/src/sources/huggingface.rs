//! HuggingFace 数据源：搜索（Link 分页）、文件树（Link 分页）、仓库信息、下载 URL。

use serde::Deserialize;
use serde_json::Value;

use crate::models::{
    RepoDetail, RepoFile, RepoSearchPage, RepoSummary, SearchQuery, Settings, Source,
};
use crate::sources::{
    encode_path, endpoint, map_network_error, parse_next_link, send_json, url_with_query,
    validate_api_next_url, with_auth,
};
use crate::util;

const SOURCE: Source = Source::Huggingface;

/// `/api/models` 搜索响应元素。
#[derive(Debug, Deserialize)]
struct HfRepoSummary {
    id: String,
    #[serde(default)]
    downloads: u64,
    #[serde(default)]
    likes: u64,
    #[serde(default, rename = "lastModified")]
    last_modified: Option<String>,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default, rename = "pipeline_tag")]
    pipeline_tag: Option<String>,
    #[serde(default)]
    gated: Option<Value>,
}

/// 文件树响应元素。
#[derive(Debug, Deserialize)]
struct HfTreeEntry {
    #[serde(rename = "type", default)]
    entry_type: String,
    #[serde(default)]
    path: String,
    #[serde(default)]
    size: u64,
    #[serde(default)]
    lfs: Option<HfLfs>,
}

#[derive(Debug, Deserialize)]
struct HfLfs {
    #[serde(default)]
    size: Option<u64>,
}

/// `GET /api/models/{repo}` 仓库信息。
#[derive(Debug, Default, Deserialize)]
struct HfRepoInfo {
    #[serde(default)]
    downloads: u64,
    #[serde(default)]
    likes: u64,
    #[serde(default, rename = "lastModified")]
    last_modified: Option<String>,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    gated: Option<Value>,
    #[serde(default, rename = "cardData")]
    card_data: Option<Value>,
}

/// HF 的 `gated` 可能是 bool、null 或 "auto"/"manual" 字符串。
fn gated_to_bool(gated: Option<Value>) -> Option<bool> {
    match gated {
        Some(Value::Bool(value)) => Some(value),
        Some(Value::String(_)) => Some(true),
        _ => None,
    }
}

fn build_search_url(settings: &Settings, query: &SearchQuery) -> Result<String, String> {
    let base = format!("{}/api/models", endpoint(settings, SOURCE));
    let limit = query.limit.to_string();
    // `full=true` 才会返回 `gated` 与 `lastModified`（否则响应只有 id/likes/downloads/tags 等）。
    url_with_query(
        &base,
        &[
            ("search", query.query.as_str()),
            ("limit", limit.as_str()),
            ("sort", "downloads"),
            ("direction", "-1"),
            ("full", "true"),
        ],
    )
}

/// 搜索仓库（命令 2）。HF 使用不透明 `cursor`（即 `Link rel=next` URL）翻页。
pub async fn search(
    client: &reqwest::Client,
    settings: &Settings,
    query: &SearchQuery,
) -> Result<RepoSearchPage, String> {
    // 第 1 页用 page=1；后续页必须带 cursor（page 参数对 HF 无意义）。
    let url = match query.cursor.as_deref() {
        Some(cursor) if !cursor.trim().is_empty() => {
            validate_api_next_url(cursor, endpoint(settings, SOURCE))
                .ok_or_else(|| "分页游标无效，请重新搜索".to_string())?
        }
        _ => build_search_url(settings, query)?,
    };

    let response = with_auth(client.get(&url), settings, SOURCE)
        .send()
        .await
        .map_err(|e| map_network_error("搜索仓库", e))?;
    let next_cursor = parse_next_link(response.headers())
        .and_then(|n| validate_api_next_url(&n, endpoint(settings, SOURCE)));
    let body = send_json(SOURCE, "搜索仓库", response).await?;

    let repos: Vec<HfRepoSummary> =
        serde_json::from_value(body).map_err(|e| format!("搜索仓库：响应格式异常（{e}）"))?;

    let items = repos
        .into_iter()
        .filter(|repo| !repo.id.trim().is_empty())
        .map(|repo| RepoSummary {
            id: repo.id,
            source: SOURCE,
            downloads: repo.downloads,
            likes: repo.likes,
            last_modified: repo.last_modified,
            tags: repo.tags,
            pipeline_tag: repo.pipeline_tag,
            gated: gated_to_bool(repo.gated),
        })
        .collect::<Vec<_>>();

    Ok(RepoSearchPage {
        items,
        has_more: next_cursor.is_some(),
        next_cursor,
    })
}

/// 仓库详情：文件树（分页聚合）+ 仓库信息（失败时降级为文件信息）。
pub async fn detail(
    client: &reqwest::Client,
    settings: &Settings,
    repo_id: &str,
    revision: Option<&str>,
) -> Result<RepoDetail, String> {
    let repo = util::sanitize_repo_id(repo_id)?;
    let revision = match revision.map(str::trim).filter(|r| !r.is_empty()) {
        Some(revision) => util::sanitize_revision(revision)?,
        None => SOURCE.default_revision().to_string(),
    };
    let base = endpoint(settings, SOURCE);

    // 文件树：GET /api/models/{repo}/tree/{rev}?recursive=true，可能多页。
    let first_url = format!(
        "{base}/api/models/{}/tree/{}?recursive=true",
        encode_path(&repo),
        crate::sources::encode_revision(&revision)
    );
    let mut files = Vec::new();
    let mut next = Some(first_url);
    let mut pages = 0usize;
    while let Some(url) = next.take() {
        pages += 1;
        if pages > 100 {
            // 防御异常分页（避免无限翻页）。
            break;
        }
        let response = with_auth(client.get(&url), settings, SOURCE)
            .send()
            .await
            .map_err(|e| map_network_error("获取仓库文件列表", e))?;
        let next_candidate =
            parse_next_link(response.headers()).and_then(|n| validate_api_next_url(&n, base));
        let body = send_json(SOURCE, "获取仓库文件列表", response).await?;
        let entries: Vec<HfTreeEntry> = serde_json::from_value(body)
            .map_err(|e| format!("获取仓库文件列表：响应格式异常（{e}）"))?;
        for entry in entries {
            // 只保留文件（目录条目 type == "directory"）。
            if entry.entry_type != "file" || entry.path.is_empty() {
                continue;
            }
            let size = entry.lfs.and_then(|lfs| lfs.size).unwrap_or(entry.size);
            let name = entry
                .path
                .rsplit('/')
                .next()
                .unwrap_or(&entry.path)
                .to_string();
            let kind = util::classify_file(&entry.path);
            files.push(RepoFile {
                path: entry.path,
                name,
                size,
                kind,
            });
        }
        next = next_candidate;
    }

    let total_size = files.iter().map(|file| file.size).sum();
    let info = fetch_repo_info(client, settings, &repo)
        .await
        .unwrap_or_default();
    let license = info
        .card_data
        .as_ref()
        .and_then(|card| card.get("license"))
        .and_then(Value::as_str)
        .map(str::to_string);

    Ok(RepoDetail {
        id: repo,
        source: SOURCE,
        revision,
        files,
        total_size,
        downloads: info.downloads,
        likes: info.likes,
        last_modified: info.last_modified,
        tags: info.tags,
        gated: gated_to_bool(info.gated),
        license,
    })
}

async fn fetch_repo_info(
    client: &reqwest::Client,
    settings: &Settings,
    repo: &str,
) -> Option<HfRepoInfo> {
    let url = format!(
        "{}/api/models/{}",
        endpoint(settings, SOURCE),
        encode_path(repo)
    );
    let response = with_auth(client.get(url), settings, SOURCE)
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let body = response.json::<Value>().await.ok()?;
    serde_json::from_value::<HfRepoInfo>(body).ok()
}

// ---------------------------------------------------------------------------
// v0.2.0 revision 列表（命令 21）
// ---------------------------------------------------------------------------

/// 从 `/api/models/{repo}/refs` 响应解析分支/标签名（纯函数，便于单测）。
pub(crate) fn parse_refs(value: &Value) -> (Vec<String>, Vec<String>) {
    fn names(array: Option<&Value>) -> Vec<String> {
        array
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| match item {
                        Value::String(name) => Some(name.clone()),
                        Value::Object(_) => {
                            item.get("name").and_then(Value::as_str).map(str::to_string)
                        }
                        _ => None,
                    })
                    .filter(|name| !name.trim().is_empty())
                    .collect()
            })
            .unwrap_or_default()
    }
    (names(value.get("branches")), names(value.get("tags")))
}

/// `GET {hf}/api/models/{repo}/refs` → 分支/标签；失败降级为空数组（UI 可自定义 revision）。
pub async fn list_revisions(
    client: &reqwest::Client,
    settings: &Settings,
    repo_id: &str,
) -> Result<crate::models::RevisionList, String> {
    let repo = util::sanitize_repo_id(repo_id)?;
    let mut list = crate::models::RevisionList {
        source: SOURCE,
        repo_id: repo.clone(),
        default_revision: SOURCE.default_revision().to_string(),
        branches: Vec::new(),
        tags: Vec::new(),
    };

    let url = format!(
        "{}/api/models/{}/refs",
        endpoint(settings, SOURCE),
        encode_path(&repo)
    );
    let response = match with_auth(client.get(url), settings, SOURCE).send().await {
        Ok(response) => response,
        Err(err) => {
            eprintln!(
                "获取 HuggingFace revision 列表失败（已降级为空列表）：{}",
                map_network_error("获取 revision 列表", err)
            );
            return Ok(list);
        }
    };
    if !response.status().is_success() {
        eprintln!(
            "获取 HuggingFace revision 列表失败（HTTP {}，已降级为空列表）",
            response.status()
        );
        return Ok(list);
    }
    let value = match response.json::<Value>().await {
        Ok(value) => value,
        Err(err) => {
            eprintln!("解析 HuggingFace revision 列表失败（已降级为空列表）：{err}");
            return Ok(list);
        }
    };
    let (branches, tags) = parse_refs(&value);
    list.branches = branches;
    list.tags = tags;
    Ok(list)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_link_next_header() {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(
            reqwest::header::LINK,
            reqwest::header::HeaderValue::from_static(
                "<https://huggingface.co/api/models?cursor=abc>; rel=\"next\", <https://huggingface.co/api/models?cursor=first>; rel=\"prev\"",
            ),
        );
        let next = parse_next_link(&headers).unwrap();
        assert_eq!(next, "https://huggingface.co/api/models?cursor=abc");
    }

    #[test]
    fn rewrites_pagination_links_for_mirror() {
        // 官方 endpoint：原样通过。
        let official = "https://huggingface.co";
        assert_eq!(
            validate_api_next_url("https://huggingface.co/api/models?cursor=abc", official)
                .as_deref(),
            Some("https://huggingface.co/api/models?cursor=abc")
        );
        // 镜像 endpoint + 官方 host 的 Link → 通过并改写为镜像 origin。
        let mirror = "https://hf-mirror.com";
        assert_eq!(
            validate_api_next_url(
                "https://huggingface.co/api/models?cursor=abc&limit=20",
                mirror
            )
            .as_deref(),
            Some("https://hf-mirror.com/api/models?cursor=abc&limit=20")
        );
        // 已改写过的镜像 URL 仍然通过。
        assert_eq!(
            validate_api_next_url("https://hf-mirror.com/api/models?cursor=abc", mirror).as_deref(),
            Some("https://hf-mirror.com/api/models?cursor=abc")
        );
        // 非法 host / scheme / path / 端口 / userinfo 一律拒绝。
        assert!(validate_api_next_url("https://evil.com/api/models", mirror).is_none());
        assert!(validate_api_next_url("http://huggingface.co/api/models", mirror).is_none());
        assert!(validate_api_next_url("https://huggingface.co/other", mirror).is_none());
        assert!(validate_api_next_url("https://huggingface.co:8443/api/models", mirror).is_none());
        assert!(
            validate_api_next_url("https://user:pass@hf-mirror.com/api/models", mirror).is_none()
        );
    }

    #[test]
    fn search_url_requests_full_metadata() {
        let settings = Settings::default();
        let query = SearchQuery {
            source: Source::Huggingface,
            query: "Qwen".to_string(),
            page: 1,
            limit: 20,
            cursor: None,
        };
        let url = build_search_url(&settings, &query).unwrap();
        assert!(
            url.starts_with("https://hf-mirror.com/api/models?"),
            "url={url}"
        );
        assert!(url.contains("full=true"), "缺少 full=true：{url}");
        assert!(url.contains("search=Qwen"), "url={url}");
        assert!(url.contains("limit=20"), "url={url}");
        assert!(url.contains("sort=downloads"), "url={url}");
        assert!(url.contains("direction=-1"), "url={url}");
    }

    #[test]
    fn maps_gated_variants() {
        assert_eq!(gated_to_bool(Some(Value::Bool(true))), Some(true));
        assert_eq!(gated_to_bool(Some(Value::Bool(false))), Some(false));
        assert_eq!(
            gated_to_bool(Some(Value::String("manual".to_string()))),
            Some(true)
        );
        assert_eq!(gated_to_bool(None), None);
    }

    #[test]
    fn download_url_matches_contract_template() {
        let settings = Settings::default();
        let url = crate::sources::download_url(
            &settings,
            Source::Huggingface,
            "Qwen/Qwen2.5-7B-Instruct",
            "main",
            "model-00001-of-00004.safetensors",
        );
        assert_eq!(
            url,
            "https://hf-mirror.com/Qwen/Qwen2.5-7B-Instruct/resolve/main/model-00001-of-00004.safetensors"
        );
    }

    #[test]
    fn parses_refs_branches_and_tags() {
        let value = serde_json::json!({
            "branches": [
                { "name": "main", "ref": "refs/heads/main" },
                { "name": "feature/x" }
            ],
            "tags": [
                { "name": "v1.0.0" },
                "v1.1.0"
            ],
            "converts": []
        });
        let (branches, tags) = parse_refs(&value);
        assert_eq!(branches, vec!["main".to_string(), "feature/x".to_string()]);
        assert_eq!(tags, vec!["v1.0.0".to_string(), "v1.1.0".to_string()]);

        // 缺字段/异常响应 → 空数组（降级）。
        let (empty_branches, empty_tags) = parse_refs(&serde_json::json!({}));
        assert!(empty_branches.is_empty());
        assert!(empty_tags.is_empty());
    }

    #[test]
    fn download_url_uses_custom_revision() {
        let settings = Settings::default();
        let url = crate::sources::download_url(
            &settings,
            Source::Huggingface,
            "Qwen/Qwen2.5-7B-Instruct",
            "refs/pr/3",
            "config.json",
        );
        assert_eq!(
            url,
            "https://hf-mirror.com/Qwen/Qwen2.5-7B-Instruct/resolve/refs%2Fpr%2F3/config.json"
        );
    }
}
