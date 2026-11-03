//! 设置：默认值 / 读写 / 校验与钳制。
//!
//! 本模块不依赖 Tauri，可被单元测试直接调用。

use std::path::{Path, PathBuf};

use crate::models::Settings;
use crate::util;

/// 默认 HuggingFace 端点。
///
/// 默认使用镜像 `https://hf-mirror.com`：本机实测 `huggingface.co` 不可达
/// （curl 21s 超时），镜像 API 200、resolve 307→200 可用；设置页仍可切回官方站。
pub const DEFAULT_HF_ENDPOINT: &str = "https://hf-mirror.com";
/// 默认 ModelScope 端点。
pub const DEFAULT_MS_ENDPOINT: &str = "https://www.modelscope.cn";

/// 默认下载目录：`%USERPROFILE%\Documents\Models`（非 Windows 用 `$HOME/Documents/Models`）。
pub fn default_download_dir() -> String {
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from);
    match home {
        Some(home) => home
            .join("Documents")
            .join("Models")
            .to_string_lossy()
            .into_owned(),
        None => "Models".to_string(),
    }
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            download_dir: default_download_dir(),
            hf_token: String::new(),
            ms_token: String::new(),
            hf_endpoint: DEFAULT_HF_ENDPOINT.to_string(),
            ms_endpoint: DEFAULT_MS_ENDPOINT.to_string(),
            proxy: String::new(),
            concurrency: 3,
            bandwidth_limit: 0,
            max_retries: 3,
            auto_resume: true,
            theme: DEFAULT_THEME.to_string(),
            close_to_tray: true,
            notifications_enabled: true,
            connections_per_file: 4,
            library_roots: Vec::new(),
        }
    }
}

/// 默认界面主题（跟随系统）。
pub const DEFAULT_THEME: &str = "system";

/// 主题规范化：只接受 `light` / `dark` / `system`（大小写不敏感），非法值回退 `system`。
pub fn normalize_theme(raw: &str) -> String {
    match raw.trim().to_ascii_lowercase().as_str() {
        "light" => "light".to_string(),
        "dark" => "dark".to_string(),
        _ => DEFAULT_THEME.to_string(),
    }
}

/// 设置文件路径：`{dataDir}/settings.json`。
pub fn settings_path(data_dir: &Path) -> PathBuf {
    data_dir.join("settings.json")
}

/// 从不信任的来源载入设置：文件缺失/损坏/字段非法时回退默认值，不阻塞启动。
pub fn load(data_dir: &Path) -> Settings {
    let path = settings_path(data_dir);
    match std::fs::read(&path) {
        Ok(bytes) => match serde_json::from_slice::<Settings>(&bytes) {
            Ok(raw) => match sanitize(raw) {
                Ok(settings) => settings,
                Err(err) => {
                    eprintln!("设置文件内容非法，已回退默认值：{err}");
                    Settings::default()
                }
            },
            Err(err) => {
                eprintln!("设置文件解析失败，已回退默认值：{err}");
                Settings::default()
            }
        },
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Settings::default(),
        Err(err) => {
            eprintln!("设置文件读取失败，已回退默认值：{err}");
            Settings::default()
        }
    }
}

/// 严格校验并钳制设置（命令 `save_settings` 使用）。
///
/// 与 [`sanitize`] 的区别：非法端点/代理/下载目录会返回中文错误，而不是静默回退。
/// 数值越界会钳制到合法区间。
pub fn validate_and_clamp(mut settings: Settings) -> Result<Settings, String> {
    settings.concurrency = settings.concurrency.clamp(1, 8);
    settings.max_retries = settings.max_retries.min(10);
    settings.connections_per_file = settings.connections_per_file.clamp(1, 8);
    settings.hf_token = settings.hf_token.trim().to_string();
    settings.ms_token = settings.ms_token.trim().to_string();
    settings.proxy = settings.proxy.trim().to_string();
    settings.theme = normalize_theme(&settings.theme);
    settings.hf_endpoint = normalize_endpoint(&settings.hf_endpoint, "HuggingFace")?;
    settings.ms_endpoint = normalize_endpoint(&settings.ms_endpoint, "ModelScope")?;
    if !settings.proxy.is_empty() {
        validate_proxy(&settings.proxy)?;
    }

    let dir = settings.download_dir.trim().to_string();
    if dir.is_empty() {
        return Err("下载目录不能为空".to_string());
    }
    if !is_absolute_dir(&dir) {
        return Err(format!("下载目录必须是绝对路径：{dir}"));
    }
    settings.download_dir = dir;
    settings.library_roots =
        normalize_library_roots(&settings.library_roots, &settings.download_dir);
    std::fs::create_dir_all(&settings.download_dir)
        .map_err(|e| format!("无法创建下载目录 {}：{e}", settings.download_dir))?;

    Ok(settings)
}

/// 宽松净化（载入设置文件使用）：数值钳制、端点/下载目录非法时静默回退默认值。
pub fn sanitize(mut settings: Settings) -> Result<Settings, String> {
    settings.concurrency = settings.concurrency.clamp(1, 8);
    settings.max_retries = settings.max_retries.min(10);
    settings.hf_token = settings.hf_token.trim().to_string();
    settings.ms_token = settings.ms_token.trim().to_string();
    settings.proxy = settings.proxy.trim().to_string();
    settings.theme = normalize_theme(&settings.theme);
    if !settings.proxy.is_empty() && validate_proxy(&settings.proxy).is_err() {
        settings.proxy = String::new();
    }
    settings.hf_endpoint = normalize_endpoint(&settings.hf_endpoint, "HuggingFace")
        .unwrap_or_else(|_| DEFAULT_HF_ENDPOINT.to_string());
    settings.ms_endpoint = normalize_endpoint(&settings.ms_endpoint, "ModelScope")
        .unwrap_or_else(|_| DEFAULT_MS_ENDPOINT.to_string());
    let dir = settings.download_dir.trim().to_string();
    settings.download_dir = if dir.is_empty() || !is_absolute_dir(&dir) {
        default_download_dir()
    } else {
        dir
    };
    settings.library_roots =
        normalize_library_roots(&settings.library_roots, &settings.download_dir);
    let _ = std::fs::create_dir_all(&settings.download_dir);
    Ok(settings)
}

/// 附件扫描根规范化（v0.2.0）：去空、必须绝对路径、去重（Windows 大小写不敏感）、
/// 不得与 `download_dir` 重复，最多保留 8 个；非法项静默忽略。
pub fn normalize_library_roots(raw: &[String], download_dir: &str) -> Vec<String> {
    fn path_key(path: &str) -> String {
        path.trim()
            .trim_end_matches(|character| character == '/' || character == '\\')
            .replace('/', "\\")
            .to_ascii_lowercase()
    }

    let download_key = path_key(download_dir);
    let mut seen = std::collections::HashSet::new();
    let mut roots = Vec::new();
    for entry in raw {
        let trimmed = entry.trim();
        if trimmed.is_empty() || !is_absolute_dir(trimmed) {
            continue;
        }
        let normalized = trimmed
            .trim_end_matches(|character| character == '/' || character == '\\')
            .to_string();
        let normalized = if normalized.is_empty() || !is_absolute_dir(&normalized) {
            trimmed.to_string()
        } else {
            normalized
        };
        let key = path_key(&normalized);
        if key == download_key || !seen.insert(key) {
            continue;
        }
        roots.push(normalized);
        if roots.len() >= 8 {
            break;
        }
    }
    roots
}

/// 保存到 `{dataDir}/settings.json`（临时文件 + rename 原子写）。
pub fn save(data_dir: &Path, settings: &Settings) -> Result<(), String> {
    let path = settings_path(data_dir);
    util::atomic_write_json(&path, settings)
}

/// 端点规范化：去空格、去尾部 `/`、必须 http(s) 且 host 非空。
pub fn normalize_endpoint(raw: &str, label: &str) -> Result<String, String> {
    let trimmed = raw.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err(format!("{label} 地址不能为空"));
    }
    let parsed = url::Url::parse(trimmed).map_err(|_| format!("{label} 地址无效：{raw}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(format!("{label} 地址必须以 http:// 或 https:// 开头"));
    }
    if parsed.host_str().map(str::is_empty).unwrap_or(true) {
        return Err(format!("{label} 地址缺少主机名：{raw}"));
    }
    Ok(trimmed.to_string())
}

/// HTTP/HTTPS/SOCKS5 代理（可带认证信息）。
pub fn validate_proxy(proxy: &str) -> Result<(), String> {
    let trimmed = proxy.trim();
    let parsed = url::Url::parse(trimmed).map_err(|_| format!("代理地址无效：{trimmed}"))?;
    if !matches!(parsed.scheme(), "http" | "https" | "socks5" | "socks5h") {
        return Err("代理地址必须以 http://、https://、socks5:// 或 socks5h:// 开头".to_string());
    }
    if parsed.host_str().map(str::is_empty).unwrap_or(true) {
        return Err(format!("代理地址缺少主机名：{trimmed}"));
    }
    Ok(())
}

fn is_absolute_dir(dir: &str) -> bool {
    let path = Path::new(dir);
    if path.is_absolute() {
        return true;
    }
    // Windows 下 "/foo" 有根但无盘符前缀，同样拒绝。
    #[cfg(windows)]
    {
        if path.has_root() {
            return false;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_settings_are_within_contract_ranges() {
        let s = Settings::default();
        assert_eq!(s.concurrency, 3);
        assert_eq!(s.bandwidth_limit, 0);
        assert_eq!(s.max_retries, 3);
        assert!(s.auto_resume);
        assert_eq!(s.hf_endpoint, DEFAULT_HF_ENDPOINT);
        assert_eq!(s.ms_endpoint, DEFAULT_MS_ENDPOINT);
        assert_eq!(s.theme, "system");
        assert!(s.close_to_tray);
        assert!(s.notifications_enabled);
        assert!(!s.download_dir.is_empty());
        assert!(Path::new(&s.download_dir).is_absolute() || cfg!(not(windows)));
    }

    #[test]
    fn normalizes_theme_and_falls_back() {
        assert_eq!(normalize_theme("light"), "light");
        assert_eq!(normalize_theme("dark"), "dark");
        assert_eq!(normalize_theme("system"), "system");
        assert_eq!(normalize_theme("  Dark "), "dark");
        // 非法值回退 system。
        assert_eq!(normalize_theme("neon"), "system");
        assert_eq!(normalize_theme(""), "system");

        let mut s = Settings::default();
        s.theme = "invalid-theme".to_string();
        s.download_dir = default_download_dir();
        let effective = validate_and_clamp(s).unwrap();
        assert_eq!(effective.theme, "system");
    }

    #[test]
    fn old_settings_json_missing_new_fields_uses_defaults() {
        // v0.1.2 及更早的 settings.json 不含 theme/closeToTray/notificationsEnabled。
        let legacy = r#"{
            "downloadDir": "C:\\Models",
            "hfToken": "",
            "msToken": "",
            "hfEndpoint": "https://hf-mirror.com",
            "msEndpoint": "https://www.modelscope.cn",
            "proxy": "",
            "concurrency": 5,
            "bandwidthLimit": 0,
            "maxRetries": 2,
            "autoResume": false
        }"#;
        let settings: Settings = serde_json::from_str(legacy).unwrap();
        assert_eq!(settings.concurrency, 5, "旧字段应保留");
        assert_eq!(settings.theme, "system", "缺失 theme 用默认值");
        assert!(settings.close_to_tray, "缺失 closeToTray 用默认 true");
        assert!(
            settings.notifications_enabled,
            "缺失 notificationsEnabled 用默认 true"
        );
        // 序列化输出必须使用 camelCase 新字段名。
        let json = serde_json::to_value(&settings).unwrap();
        assert_eq!(json["theme"], "system");
        assert_eq!(json["closeToTray"], true);
        assert_eq!(json["notificationsEnabled"], true);
    }

    #[test]
    fn clamps_out_of_range_numbers() {
        let mut s = Settings::default();
        s.concurrency = 99;
        s.max_retries = 99;
        s.download_dir = default_download_dir();
        // 避免在测试里创建用户目录，仅检查数值钳制分支（端点合法）。
        let effective = validate_and_clamp(s).unwrap();
        assert_eq!(effective.concurrency, 8);
        assert_eq!(effective.max_retries, 10);
    }

    #[test]
    fn normalizes_endpoints() {
        assert_eq!(
            normalize_endpoint("https://hf-mirror.com/", "HF").unwrap(),
            "https://hf-mirror.com"
        );
        assert!(normalize_endpoint("ftp://x", "HF").is_err());
        assert!(normalize_endpoint("", "HF").is_err());
    }

    #[test]
    fn rejects_relative_download_dir() {
        let mut s = Settings::default();
        s.download_dir = "relative/path".to_string();
        assert!(validate_and_clamp(s).is_err());
    }

    #[test]
    fn default_connections_per_file_is_four_and_clamped() {
        assert_eq!(Settings::default().connections_per_file, 4);
        let mut s = Settings::default();
        s.download_dir = default_download_dir();
        s.connections_per_file = 99;
        assert_eq!(
            validate_and_clamp(s.clone()).unwrap().connections_per_file,
            8
        );
        s.connections_per_file = 0;
        assert_eq!(validate_and_clamp(s).unwrap().connections_per_file, 1);
    }

    #[test]
    fn normalizes_library_roots() {
        let download = "C:\\Models";
        let roots = normalize_library_roots(
            &[
                "  D:\\Models  ".to_string(),
                "D:\\Models".to_string(),         // 去重
                "d:\\models".to_string(),         // 大小写不敏感去重
                "relative\\path".to_string(),     // 非法（相对路径）忽略
                "".to_string(),                   // 空忽略
                "C:\\Models\\".to_string(),       // 与 downloadDir 重复忽略
                "C:\\Models\\Nested".to_string(), // 合法
            ],
            download,
        );
        assert_eq!(
            roots,
            vec!["D:\\Models".to_string(), "C:\\Models\\Nested".to_string()]
        );

        // 超过 8 个时截断。
        let many: Vec<String> = (0..12).map(|index| format!("D:\\root-{index}")).collect();
        assert_eq!(normalize_library_roots(&many, download).len(), 8);
    }

    #[test]
    fn legacy_settings_json_defaults_new_v020_fields() {
        let legacy = r#"{"downloadDir":"C:\\Models","concurrency":5}"#;
        let settings: Settings = serde_json::from_str(legacy).unwrap();
        assert_eq!(
            settings.connections_per_file, 4,
            "缺失 connectionsPerFile 用默认 4"
        );
        assert!(
            settings.library_roots.is_empty(),
            "缺失 libraryRoots 用默认空数组"
        );
        let json = serde_json::to_value(&settings).unwrap();
        assert_eq!(json["connectionsPerFile"], 4);
        assert_eq!(json["libraryRoots"], serde_json::json!([]));
    }
}
