//! ModelScope 数据源：搜索（PUT `/api/v1/dolphin/models`）、文件列表、下载 URL。
//!
//! 端点（Lead 实测确认，匿名可用）：
//! - 搜索：`PUT {ms}/api/v1/dolphin/models`，body 字段 PascalCase：
//!   `{"PageSize","PageNumber","SortBy":"Default","Target":"","SingleCriterion":[],"Name","Criterion":[]}`，
//!   响应 `Data.Model.Models[]` + `Data.Model.TotalCount`；`POST` 该路径为 404。
//! - 文件列表：`GET {ms}/api/v1/models/{repo}/repo/files?Recursive=true`（`Data.Files[]`，`Type=="blob"`）。
//! - 下载：`GET {ms}/models/{repo}/resolve/{rev}/{path}`；实测对 Range 请求返回
//!   `200 + Content-Range`（非 206），下载引擎已兼容该语义。
//!
//! 搜索失败时返回明确中文提示（引导用户直接输入仓库 ID）；`get_repo_detail` 走文件列表接口，
//! 不依赖搜索，因此即使搜索不可用也能浏览与下载任意仓库。

use serde_json::Value;

use crate::models::{
    RepoDetail, RepoFile, RepoSearchPage, RepoSummary, RevisionList, SearchQuery, Settings, Source,
};
use crate::sources::{endpoint, encode_path, map_network_error, send_json, url_with_query, with_auth};
use crate::util;

const SOURCE: Source = Source::Modelscope;

/// 搜索不可用时的用户提示（前端可直接展示）。
pub const SEARCH_UNAVAILABLE_MESSAGE: &str =
    "ModelScope 搜索暂不可用，请直接输入仓库 ID（如 Qwen/Qwen2.5-0.5B-Instruct）打开";

/// 搜索响应中模型数组可能出现的嵌套路径。
const MODEL_PATHS: &[&[&str]] = &[
    &["Data", "Model", "Models"],
    &["Data", "Models"],
    &["Data", "Model", "Data"],
];

/// 总数可能出现的嵌套路径。
const TOTAL_PATHS: &[&[&str]] = &[
    &["Data", "Model", "TotalCount"],
    &["Data", "TotalCount"],
    &["Data", "Model", "Total"],
];

fn get_path<'a>(value: &'a Value, path: &[&str]) -> Option<&'a Value> {
    let mut current = value;
    for key in path {
        current = current.get(*key)?;
    }
    Some(current)
}

fn find_models(value: &Value) -> Option<Vec<Value>> {
    for path in MODEL_PATHS {
        if let Some(array) = get_path(value, path).and_then(Value::as_array) {
            return Some(array.clone());
        }
    }
    None
}

fn find_total(value: &Value) -> Option<u64> {
    TOTAL_PATHS
        .iter()
        .find_map(|path| get_path(value, path).and_then(Value::as_u64))
}

fn number_at(value: &Value, keys: &[&str]) -> u64 {
    for key in keys {
        if let Some(field) = value.get(*key) {
            if let Some(number) = field.as_u64() {
                return number;
            }
            if let Some(number) = field.as_str().and_then(|text| text.trim().parse().ok()) {
                return number;
            }
        }
    }
    0
}

/// ModelScope 文件条目上的内容校验和。只接受 `Sha256` 字段。
pub(crate) fn entry_sha256(entry: &Value) -> Option<String> {
    string_at(entry, &["Sha256", "sha256"]).and_then(|raw| crate::integrity::normalize_sha256(&raw))
}

fn string_at(value: &Value, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(text) = value.get(*key).and_then(Value::as_str) {
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

/// 取字符串数组字段（如 `Tags`、`Libraries`），忽略非字符串元素。
fn string_array_at(value: &Value, keys: &[&str]) -> Vec<String> {
    for key in keys {
        if let Some(array) = value.get(*key).and_then(Value::as_array) {
            return array
                .iter()
                .filter_map(|item| match item {
                    Value::String(text) => Some(text.clone()),
                    Value::Object(_) => string_at(item, &["Name", "Tag", "Label"]),
                    _ => None,
                })
                .collect();
        }
    }
    Vec::new()
}

/// `Tasks` 数组第一个元素（pipelineTag）。
fn first_task(value: &Value) -> Option<String> {
    let tasks = value.get("Tasks").and_then(Value::as_array)?;
    tasks.iter().find_map(|task| match task {
        Value::String(text) if !text.trim().is_empty() => Some(text.trim().to_string()),
        Value::Object(_) => string_at(task, &["Name", "TaskName"]),
        _ => None,
    })
}

/// Unix 秒 → ISO-8601 UTC（如 `"2026-11-03T10:00:00Z"`）；0 视为无值。
fn unix_seconds_to_iso8601(seconds: u64) -> Option<String> {
    if seconds == 0 {
        return None;
    }
    let days = (seconds / 86_400) as i64;
    let seconds_of_day = seconds % 86_400;
    let (hour, minute, second) = (
        seconds_of_day / 3600,
        (seconds_of_day % 3600) / 60,
        seconds_of_day % 60,
    );

    // Howard Hinnant 的 civil_from_days 算法（避免引入 chrono 依赖）。
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let day_of_era = z - era * 146_097; // [0, 146096]
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365; // [0, 399]
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100); // [0, 365]
    let mp = (5 * day_of_year + 2) / 153; // [0, 11]
    let day = day_of_year - (153 * mp + 2) / 5 + 1; // [1, 31]
    let month = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    let year = if month <= 2 { year + 1 } else { year };

    Some(format!(
        "{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z"
    ))
}

/// 由 `Path` + `Name` 组成仓库 ID（如 `Qwen/Qwen2.5-0.5B-Instruct`）。
fn model_identity(item: &Value) -> Option<String> {
    let name = string_at(item, &["Name"])?;
    match string_at(item, &["Path"]) {
        Some(path) => Some(format!("{}/{}", path.trim_matches('/'), name)),
        None => Some(name),
    }
}

/// 单条搜索结果 → `RepoSummary`（字段映射见文件头注释）。
fn parse_summary(item: &Value) -> Option<RepoSummary> {
    let id = model_identity(item)?;
    let mut tags = string_array_at(item, &["Tags"]);
    for library in string_array_at(item, &["Libraries"]) {
        if !tags.contains(&library) {
            tags.push(library);
        }
    }
    Some(RepoSummary {
        id,
        source: SOURCE,
        downloads: number_at(item, &["Downloads"]),
        likes: number_at(item, &["Stars", "Likes"]),
        last_modified: unix_seconds_to_iso8601(number_at(item, &["LastUpdatedTime"])),
        tags,
        pipeline_tag: first_task(item),
        // ModelScope 的 Visibility/ApprovalMode 暂不映射为 gated。
        gated: Some(false),
    })
}

fn build_summary_page(value: &Value, page: u32, limit: u32) -> Option<RepoSearchPage> {
    let models = find_models(value)?;
    let items: Vec<RepoSummary> = models.iter().filter_map(parse_summary).collect();
    let has_more = match find_total(value) {
        Some(total) => u64::from(page) * u64::from(limit) < total,
        None => items.len() >= limit as usize,
    };
    Some(RepoSearchPage {
        items,
        has_more,
        next_cursor: None,
    })
}

/// `Success: false` / `Code != 200` → 中文错误（`Message` 原样保留）。
fn ensure_success(value: &Value, context: &str) -> Result<(), String> {
    if let Some(success) = value.get("Success").and_then(Value::as_bool) {
        if !success {
            let message = string_at(value, &["Message", "ErrorMessage"]).unwrap_or_default();
            return Err(if message.is_empty() {
                format!("{context}失败")
            } else {
                format!("{context}失败：{message}")
            });
        }
    }
    if let Some(code) = value.get("Code").and_then(Value::as_i64) {
        if code != 200 {
            let message = string_at(value, &["Message", "ErrorMessage"]).unwrap_or_default();
            return Err(if message.is_empty() {
                format!("{context}失败（Code {code}）")
            } else {
                format!("{context}失败：{message}（Code {code}）")
            });
        }
    }
    Ok(())
}

/// 调用搜索接口（PUT，匿名可用），返回原始响应 JSON。
async fn put_search(
    client: &reqwest::Client,
    settings: &Settings,
    name: &str,
    page: u32,
    limit: u32,
) -> Result<Value, String> {
    let url = format!("{}/api/v1/dolphin/models", endpoint(settings, SOURCE));
    let body = serde_json::json!({
        "PageSize": limit,
        "PageNumber": page,
        "SortBy": "Default",
        "Target": "",
        "SingleCriterion": [],
        "Name": name,
        "Criterion": [],
    });
    let response = with_auth(client.put(&url).json(&body), settings, SOURCE)
        .send()
        .await
        .map_err(|e| map_network_error("搜索仓库", e))?;
    let value = send_json(SOURCE, "搜索仓库", response).await?;
    ensure_success(&value, "搜索仓库")?;
    Ok(value)
}

/// 搜索仓库（命令 2）。失败时返回明确的中文降级提示。
pub async fn search(
    client: &reqwest::Client,
    settings: &Settings,
    query: &SearchQuery,
) -> Result<RepoSearchPage, String> {
    let result = async {
        let value = put_search(client, settings, &query.query, query.page, query.limit).await?;
        build_summary_page(&value, query.page, query.limit)
            .ok_or_else(|| "搜索仓库：响应格式异常（未找到模型列表）".to_string())
    }
    .await;
    result.map_err(|err| {
        eprintln!("ModelScope 搜索失败：{err}");
        SEARCH_UNAVAILABLE_MESSAGE.to_string()
    })
}

/// 文件列表 URL（v0.2.0：显式携带 `Revision`，默认 `master` 也传）。
pub(crate) fn files_url(
    settings: &Settings,
    repo: &str,
    revision: &str,
) -> Result<String, String> {
    let base = format!(
        "{}/api/v1/models/{}/repo/files",
        endpoint(settings, SOURCE),
        encode_path(repo)
    );
    url_with_query(&base, &[("Recursive", "true"), ("Revision", revision)])
}

/// 仓库详情：`GET /api/v1/models/{repo}/repo/files?Recursive=true&Revision={rev}`。
pub async fn detail(
    client: &reqwest::Client,
    settings: &Settings,
    repo_id: &str,
    revision: Option<&str>,
) -> Result<RepoDetail, String> {
    let repo = util::sanitize_repo_id(repo_id)?;
    let revision = match revision.map(str::trim).filter(|revision| !revision.is_empty()) {
        Some(revision) => util::sanitize_remote_path(revision)?,
        None => SOURCE.default_revision().to_string(),
    };
    let url = files_url(settings, &repo, &revision)?;

    let response = with_auth(client.get(&url), settings, SOURCE)
        .send()
        .await
        .map_err(|e| map_network_error("获取仓库文件列表", e))?;
    let value = send_json(SOURCE, "获取仓库文件列表", response).await?;
    ensure_success(&value, "获取仓库文件列表")?;

    let entries = value
        .get("Data")
        .and_then(|data| data.get("Files"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let mut files = Vec::new();
    for entry in entries {
        // 只要文件（Type == "blob"），跳过目录。
        if entry.get("Type").and_then(Value::as_str) != Some("blob") {
            continue;
        }
        let Some(raw_path) = string_at(&entry, &["Path", "Name"]) else {
            continue;
        };
        let path = raw_path.trim_start_matches('/').to_string();
        if path.is_empty() {
            continue;
        }
        let size = entry
            .get("Size")
            .and_then(Value::as_u64)
            .unwrap_or_else(|| number_at(&entry, &["Size", "FileSize"]));
        let name = path.rsplit('/').next().unwrap_or(&path).to_string();
        let kind = util::classify_file(&path);
        let sha256 = entry_sha256(&entry);
        files.push(RepoFile {
            path,
            name,
            size,
            kind,
            sha256,
        });
    }

    let total_size = files.iter().map(|file| file.size).sum();
    // 元数据尽力而为：搜索接口不可用时不影响文件列表与下载。
    let info = fetch_repo_info(client, settings, &repo).await.unwrap_or_default();

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
        gated: Some(false),
        license: info.license,
    })
}

#[derive(Debug, Default)]
struct MsRepoInfo {
    downloads: u64,
    likes: u64,
    last_modified: Option<String>,
    tags: Vec<String>,
    license: Option<String>,
}

/// 用搜索接口按 `Name` 精确匹配 `Path/Name == repoId` 填充详情元数据；失败返回 `None`。
async fn fetch_repo_info(
    client: &reqwest::Client,
    settings: &Settings,
    repo_id: &str,
) -> Option<MsRepoInfo> {
    let repo_name = repo_id.rsplit('/').next().unwrap_or(repo_id);
    let value = put_search(client, settings, repo_name, 1, 30).await.ok()?;
    let models = find_models(&value)?;
    let target = models.iter().find(|item| {
        model_identity(item)
            .map(|id| id.eq_ignore_ascii_case(repo_id))
            .unwrap_or(false)
    })?;
    Some(MsRepoInfo {
        downloads: number_at(target, &["Downloads"]),
        likes: number_at(target, &["Stars", "Likes"]),
        last_modified: unix_seconds_to_iso8601(number_at(target, &["LastUpdatedTime"])),
        tags: string_array_at(target, &["Tags"]),
        license: string_at(target, &["License", "LicenseName"]),
    })
}

// ---------------------------------------------------------------------------
// v0.2.0 revision 列表（命令 21，尽力探测；失败降级为空数组）
// ---------------------------------------------------------------------------

fn collect_revision_names(value: &Value) -> (Vec<String>, Vec<String>) {
    fn push_names(value: Option<&Value>, out: &mut Vec<String>) {
        if let Some(array) = value.and_then(Value::as_array) {
            for item in array {
                let name = match item {
                    Value::String(name) => Some(name.clone()),
                    Value::Object(_) => string_at(item, &["Name", "Revision", "Branch", "Tag"]),
                    _ => None,
                };
                if let Some(name) = name {
                    let name = name.trim().to_string();
                    if !name.is_empty() && !out.contains(&name) {
                        out.push(name);
                    }
                }
            }
        }
    }

    fn walk(value: &Value) -> (Vec<String>, Vec<String>) {
        let mut branches = Vec::new();
        let mut tags = Vec::new();
        for key in ["Branches", "branches", "Revisions", "revisions", "Versions", "versions"] {
            push_names(value.get(key), &mut branches);
        }
        // 注意：ModelScope 详情接口的 `Tags` 是仓库标签（如 "chat"），不是 revision；
        // 仅当明确返回 revision 标签字段时才采用，避免污染 revision 列表。
        for key in ["RevisionTags", "revisionTags"] {
            push_names(value.get(key), &mut tags);
        }
        if branches.is_empty() && tags.is_empty() {
            if let Some(data) = value.get("Data") {
                return walk(data);
            }
        }
        (branches, tags)
    }

    walk(value)
}

/// ModelScope revision 列表：尽力探测常见端点，任一返回分支/标签即采用；失败降级为空数组。
pub async fn list_revisions(
    client: &reqwest::Client,
    settings: &Settings,
    repo_id: &str,
) -> Result<RevisionList, String> {
    let repo = util::sanitize_repo_id(repo_id)?;
    let mut list = RevisionList {
        source: SOURCE,
        repo_id: repo.clone(),
        default_revision: SOURCE.default_revision().to_string(),
        branches: Vec::new(),
        tags: Vec::new(),
    };
    let base = endpoint(settings, SOURCE);
    // 仅探测可能的 revisions/refs 端点；`/api/v1/models/{repo}` 的 Tags 是仓库标签，不能当 revision。
    let candidates = [
        format!("{base}/api/v1/models/{}/repo/refs", encode_path(&repo)),
        format!("{base}/api/v1/models/{}/revisions", encode_path(&repo)),
    ];
    for url in candidates {
        let response = match with_auth(client.get(&url), settings, SOURCE).send().await {
            Ok(response) => response,
            Err(_) => continue,
        };
        if !response.status().is_success() {
            continue;
        }
        let Ok(value) = response.json::<Value>().await else {
            continue;
        };
        if ensure_success(&value, "获取 revision 列表").is_err() {
            continue;
        }
        let (branches, tags) = collect_revision_names(&value);
        if !branches.is_empty() || !tags.is_empty() {
            list.branches = branches;
            list.tags = tags;
            return Ok(list);
        }
    }
    eprintln!(
        "ModelScope revision 列表不可用（接口未确认），已降级为空列表，UI 可自定义 revision"
    );
    Ok(list)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entry_sha256_reads_hex_and_ignores_blank() {
        let entry = serde_json::json!({
            "Sha256": "BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD",
            "Size": 3
        });
        assert_eq!(
            entry_sha256(&entry).as_deref(),
            Some("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
        );
        assert!(entry_sha256(&serde_json::json!({"Sha256": ""})).is_none());
        assert!(entry_sha256(&serde_json::json!({"Oid": "not-a-hash"})).is_none());
    }

    #[test]
    fn collect_revision_names_reads_nested_data() {
        let value = serde_json::json!({
            "Code": 200,
            "Data": {
                "Branches": [{ "Name": "master" }, { "Name": "dev" }],
                "RevisionTags": ["v1.0", "v1.1"]
            }
        });
        let (branches, tags) = collect_revision_names(&value);
        assert_eq!(branches, vec!["master".to_string(), "dev".to_string()]);
        assert_eq!(tags, vec!["v1.0".to_string(), "v1.1".to_string()]);

        // 仓库标签（Tags）不得混入 revision 列表。
        let repo_like = serde_json::json!({ "Data": { "Tags": ["chat"] } });
        let (branches, tags) = collect_revision_names(&repo_like);
        assert!(branches.is_empty());
        assert!(tags.is_empty());
    }

    #[test]
    fn files_url_always_includes_revision() {
        let settings = Settings::default();
        let url = files_url(&settings, "Qwen/Qwen2.5-0.5B-Instruct", "master").unwrap();
        assert!(url.contains("Recursive=true"), "url={url}");
        assert!(url.contains("Revision=master"), "url={url}");

        let custom = files_url(&settings, "Qwen/Qwen2.5-0.5B-Instruct", "v1.0").unwrap();
        assert!(custom.contains("Revision=v1.0"), "url={custom}");
    }

    #[test]
    fn maps_model_fields_per_lead_contract() {
        let item = serde_json::json!({
            "Path": "Qwen",
            "Name": "Qwen2.5-0.5B-Instruct",
            "Downloads": 12345,
            "Stars": 42,
            "LastUpdatedTime": 1_700_000_000,
            "Tags": ["text-generation"],
            "Libraries": ["pytorch"],
            "Tasks": ["text-generation"]
        });
        let summary = parse_summary(&item).unwrap();
        assert_eq!(summary.id, "Qwen/Qwen2.5-0.5B-Instruct");
        assert_eq!(summary.downloads, 12345);
        assert_eq!(summary.likes, 42);
        assert_eq!(
            summary.last_modified.as_deref(),
            Some("2023-11-14T22:13:20Z")
        );
        assert_eq!(summary.tags, vec!["text-generation", "pytorch"]);
        assert_eq!(summary.pipeline_tag.as_deref(), Some("text-generation"));
        assert_eq!(summary.gated, Some(false));
    }

    #[test]
    fn builds_page_from_put_response_shape() {
        let value = serde_json::json!({
            "Code": 200,
            "Message": "success",
            "Success": true,
            "Data": {
                "Model": {
                    "Models": [
                        { "Path": "Qwen", "Name": "Qwen2.5-7B-Instruct", "Downloads": 10, "Stars": 2 },
                        { "Path": "Qwen", "Name": "Qwen2.5-0.5B-Instruct", "Downloads": 20, "Stars": 3 }
                    ],
                    "TotalCount": 28558
                }
            }
        });
        let page = build_summary_page(&value, 1, 30).unwrap();
        assert_eq!(page.items.len(), 2);
        assert_eq!(page.items[0].id, "Qwen/Qwen2.5-7B-Instruct");
        assert!(page.has_more);
    }

    #[test]
    fn last_modified_zero_is_omitted() {
        assert_eq!(unix_seconds_to_iso8601(0), None);
        assert_eq!(
            unix_seconds_to_iso8601(1_700_000_000).as_deref(),
            Some("2023-11-14T22:13:20Z")
        );
    }

    #[test]
    fn surfaces_business_errors_in_chinese() {
        let value = serde_json::json!({
            "Code": 403,
            "Success": false,
            "Message": "无权访问"
        });
        let err = ensure_success(&value, "获取仓库文件列表").unwrap_err();
        assert!(err.contains("无权访问"));
        assert!(err.starts_with("获取仓库文件列表失败"));
    }

    #[test]
    fn download_url_matches_modelscope_template() {
        let settings = Settings::default();
        let url = crate::sources::download_url(
            &settings,
            Source::Modelscope,
            "Qwen/Qwen2.5-7B-Instruct",
            "master",
            "model-00001-of-00004.safetensors",
        );
        assert_eq!(
            url,
            "https://www.modelscope.cn/models/Qwen/Qwen2.5-7B-Instruct/resolve/master/model-00001-of-00004.safetensors"
        );
    }
}
