//! 手动联网探测（不参与测试）：验证两个数据源的真实 API 解析与真实小文件下载。
//! 用法：`cargo run --example probe_sources`

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use model_download_manager_lib::download::{transfer, TransferContext};
use model_download_manager_lib::models::{SearchQuery, Settings, Source};
use model_download_manager_lib::sources;
use model_download_manager_lib::state::TaskControl;
use model_download_manager_lib::util::{self, BandwidthLimiter, NoopSink};

#[tokio::main]
async fn main() {
    let settings = Settings::default();
    println!(
        "endpoints: hf={} ms={}",
        settings.hf_endpoint, settings.ms_endpoint
    );
    let client = match util::build_http_client(&settings) {
        Ok(client) => client,
        Err(err) => {
            println!("client build error: {err}");
            return;
        }
    };

    for (source, repo, query) in [
        (Source::Huggingface, "Qwen/Qwen2.5-0.5B-Instruct", "Qwen"),
        (Source::Modelscope, "Qwen/Qwen2.5-0.5B-Instruct", "Qwen"),
    ] {
        let search = SearchQuery {
            source,
            query: query.to_string(),
            page: 1,
            limit: 3,
            cursor: None,
        };
        match sources::search(&client, &settings, &search).await {
            Ok(page) => {
                println!(
                    "[{}] search OK items={} has_more={} first={:?}",
                    source,
                    page.items.len(),
                    page.has_more,
                    page.items.first().map(|item| (
                        item.id.as_str(),
                        item.downloads,
                        item.likes,
                        item.last_modified.as_deref(),
                    )),
                );
                // 翻页验证：HF 的 nextCursor 应能被校验并重写为当前端点后成功请求。
                if let Some(cursor) = page.next_cursor.clone() {
                    let page_two = SearchQuery {
                        source,
                        query: query.to_string(),
                        page: 2,
                        limit: 3,
                        cursor: Some(cursor),
                    };
                    match sources::search(&client, &settings, &page_two).await {
                        Ok(second) => println!(
                            "[{}] page2 OK items={} has_more={} first={:?}",
                            source,
                            second.items.len(),
                            second.has_more,
                            second.items.first().map(|item| item.id.as_str()),
                        ),
                        Err(err) => println!("[{}] page2 ERR: {err}", source),
                    }
                }
            }
            Err(err) => println!("[{}] search ERR: {err}", source),
        }

        let detail = match sources::get_repo_detail(&client, &settings, source, repo, None).await {
            Ok(detail) => {
                println!(
                    "[{}] detail OK repo={} revision={} files={} total={} downloads={} likes={} tags={} license={:?}",
                    source,
                    detail.id,
                    detail.revision,
                    detail.files.len(),
                    detail.total_size,
                    detail.downloads,
                    detail.likes,
                    detail.tags.len(),
                    detail.license,
                );
                detail
            }
            Err(err) => {
                println!("[{}] detail ERR: {err}", source);
                continue;
            }
        };

        match sources::test_connection(&client, &settings, source).await {
            Ok(message) => println!("[{}] test_connection: {message}", source),
            Err(err) => println!("[{}] test_connection ERR: {err}", source),
        }

        // v0.2.0 revision 列表（HF refs；ModelScope 尽力，失败降级为空数组）。
        match sources::list_revisions(&client, &settings, source, repo).await {
            Ok(list) => println!(
                "[{}] list_revisions OK default={} branches={:?} tags={:?}",
                source, list.default_revision, list.branches, list.tags
            ),
            Err(err) => println!("[{}] list_revisions ERR: {err}", source),
        }

        // 真实小文件下载：优先 config.json（KB 级）。
        let Some(file) = detail
            .files
            .iter()
            .find(|file| file.name == "config.json" && file.size > 0 && file.size < 5_000_000)
            .or_else(|| detail.files.iter().find(|file| file.size > 0 && file.size < 5_000_000))
        else {
            println!("[{}] 没有适合探测的小文件", source);
            continue;
        };

        let base = std::env::temp_dir().join(format!(
            "mdm-probe-{}-{}",
            source.as_str(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0)
        ));
        let save_dir = base.to_string_lossy().into_owned();
        let paths = match util::prepare_download(&save_dir, &detail.id, &file.path) {
            Ok(paths) => paths,
            Err(err) => {
                println!("[{}] prepare_download ERR: {err}", source);
                continue;
            }
        };
        let url = sources::download_url(
            &settings,
            source,
            &detail.id,
            &detail.revision,
            &file.path,
        );
        let context = TransferContext {
            task_id: "probe".to_string(),
            repo_id: detail.id.clone(),
            remote_path: file.path.clone(),
            client: client.clone(),
            url,
            source,
            auth_token: sources::auth_token(&settings, source),
            save_path: paths.final_path.clone(),
            part_path: paths.part_path.clone(),
            meta_path: paths.meta_path.clone(),
            total_size: file.size,
            etag: None,
            last_modified: None,
            max_retries: 1,
            limiter: Arc::new(BandwidthLimiter::new(0)),
            control: TaskControl::new(),
            on_retry: None,
            connections: settings.connections_per_file.clamp(1, 8),
            chunk_size_override: None,
        };
        match transfer(context, &NoopSink).await {
            Ok(outcome) => {
                let downloaded = std::fs::metadata(&paths.final_path)
                    .map(|metadata| metadata.len())
                    .unwrap_or(0);
                println!(
                    "[{}] download OK outcome={outcome:?} bytes={downloaded} expected={} path={}",
                    source,
                    file.size,
                    PathBuf::from(&paths.final_path).display()
                );
            }
            Err(err) => println!("[{}] download ERR: {err}", source),
        }
        let _ = std::fs::remove_dir_all(&base);
    }
}
