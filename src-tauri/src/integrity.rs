//! 下载完成后的内容校验。只保存并比对 sha256，不阻塞下载队列。

use std::collections::HashMap;
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::util;

/// 接受 `sha256:` 前缀或 64 位十六进制，统一成小写十六进制。非法值返回 `None`。
pub fn normalize_sha256(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let hex = trimmed
        .strip_prefix("sha256:")
        .or_else(|| trimmed.strip_prefix("SHA256:"))
        .unwrap_or(trimmed);
    if hex.len() == 64 && hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Some(hex.to_ascii_lowercase())
    } else {
        None
    }
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

/// 流式计算文件 sha256，避免把大文件读进内存。
pub fn sha256_file(path: &Path) -> Result<String, String> {
    let file = File::open(path).map_err(|error| format!("无法读取文件以校验：{error}"))?;
    hash_reader(file)
}

fn hash_reader(mut file: impl Read) -> Result<String, String> {
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1024 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("无法读取文件以校验：{error}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex_encode(&hasher.finalize()))
}

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
struct FileStamp {
    size: u64,
    modified: SystemTime,
    created: Option<SystemTime>,
    #[cfg(windows)]
    identity: Option<(u64, [u8; 16], i64)>,
    #[cfg(unix)]
    identity: (u64, u64, i64, i64),
}

impl FileStamp {
    fn read(file: &File) -> Option<Self> {
        let metadata = file.metadata().ok()?;
        #[cfg(unix)]
        use std::os::unix::fs::MetadataExt;
        Some(Self {
            size: metadata.len(),
            modified: metadata.modified().ok()?,
            created: metadata.created().ok(),
            #[cfg(windows)]
            identity: windows_identity(file),
            #[cfg(unix)]
            identity: (
                metadata.dev(),
                metadata.ino(),
                metadata.ctime(),
                metadata.ctime_nsec(),
            ),
        })
    }

    fn cacheable(&self) -> bool {
        #[cfg(windows)]
        {
            self.identity.is_some()
        }
        #[cfg(not(windows))]
        {
            true
        }
    }
}

// NTFS 即使保留原修改时间，替换文件或改写内容仍会改变文件 ID 或 ChangeTime。
#[cfg(windows)]
fn windows_identity(file: &File) -> Option<(u64, [u8; 16], i64)> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        FileBasicInfo, FileIdInfo, GetFileInformationByHandleEx, FILE_BASIC_INFO, FILE_ID_INFO,
    };
    let mut basic = FILE_BASIC_INFO::default();
    let mut id = FILE_ID_INFO::default();
    // Both output buffers have the Win32 structure and size for the specified information class.
    let ok = unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle(),
            FileBasicInfo,
            std::ptr::addr_of_mut!(basic).cast(),
            std::mem::size_of_val(&basic) as u32,
        ) != 0
            && GetFileInformationByHandleEx(
                file.as_raw_handle(),
                FileIdInfo,
                std::ptr::addr_of_mut!(id).cast(),
                std::mem::size_of_val(&id) as u32,
            ) != 0
    };
    (ok && basic.ChangeTime != 0).then_some((
        id.VolumeSerialNumber,
        id.FileId.Identifier,
        basic.ChangeTime,
    ))
}

#[derive(Serialize, Deserialize)]
struct CachedDigest {
    stamp: FileStamp,
    sha256: String,
}

/// 只缓存从本机实际读取的摘要。下载记录中的远端期望值不能填充此缓存。
pub struct DigestCache {
    path: PathBuf,
    entries: Mutex<HashMap<String, CachedDigest>>,
    reader: Mutex<()>,
}

impl DigestCache {
    pub fn open(data_dir: &Path) -> Self {
        let path = data_dir.join("local-digests.json");
        Self {
            entries: Mutex::new(util::read_json_opt(&path).unwrap_or_default()),
            path,
            reader: Mutex::new(()),
        }
    }

    fn cached(&self, key: &str, stamp: &FileStamp) -> Option<String> {
        let entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        let cached = entries.get(key)?;
        (&cached.stamp == stamp).then(|| cached.sha256.clone())
    }

    pub fn lookup(&self, path: &Path) -> Option<String> {
        let file = File::open(path).ok()?;
        self.cached(&util::task_path_key(path), &FileStamp::read(&file)?)
    }

    pub fn digest(&self, path: &Path) -> Result<String, String> {
        // 下载完成和浏览镜像可能同时校验同一个大文件。等待读取槽后再次查缓存。
        let _reader = self.reader.lock().unwrap_or_else(|e| e.into_inner());
        let file = File::open(path).map_err(|e| format!("无法读取文件以校验：{e}"))?;
        let key = util::task_path_key(path);
        let before = FileStamp::read(&file);
        if let Some(digest) = before.as_ref().and_then(|stamp| self.cached(&key, stamp)) {
            return Ok(digest);
        }
        let digest = hash_reader(&file)?;
        let after = File::open(path).map_err(|e| e.to_string())?;
        if before != FileStamp::read(&after) {
            return Err("校验期间文件发生变化，请刷新后重试".into());
        }
        if let Some(stamp) = before.filter(FileStamp::cacheable) {
            let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
            entries.insert(
                key,
                CachedDigest {
                    stamp,
                    sha256: digest.clone(),
                },
            );
            if let Err(error) = util::atomic_write_json(&self.path, &*entries) {
                eprintln!("保存本地文件校验缓存失败：{error}");
            }
        }
        Ok(digest)
    }

    pub fn check_file(&self, path: &Path, expected: &str) -> ContentCheck {
        compare_digest(expected, || self.digest(path))
    }
}

pub enum ContentCheck {
    Match,
    Mismatch { actual: String },
    Unreadable { message: String },
}

pub fn check_file(path: &Path, expected: &str) -> ContentCheck {
    compare_digest(expected, || sha256_file(path))
}

fn compare_digest(expected: &str, read: impl FnOnce() -> Result<String, String>) -> ContentCheck {
    let Some(expected) = normalize_sha256(expected) else {
        return ContentCheck::Unreadable {
            message: "校验和格式无效".to_string(),
        };
    };
    match read() {
        Ok(actual) if actual == expected => ContentCheck::Match,
        Ok(actual) => ContentCheck::Mismatch { actual },
        Err(message) => ContentCheck::Unreadable { message },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_prefixed_and_plain_hex() {
        let hex = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
        assert_eq!(
            normalize_sha256(&format!("sha256:{hex}")).as_deref(),
            Some(hex)
        );
        assert_eq!(normalize_sha256(&hex.to_uppercase()).as_deref(), Some(hex));
        assert!(normalize_sha256("abc").is_none());
        assert!(normalize_sha256("").is_none());
    }

    #[test]
    fn hashes_file_contents() {
        let dir = std::env::temp_dir().join(format!("mdm-sha-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("abc.bin");
        std::fs::write(&path, b"abc").unwrap();
        let cache = DigestCache::open(&dir);
        let digest = sha256_file(&path).unwrap();
        assert_eq!(
            digest,
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert!(matches!(
            cache.check_file(&path, &digest),
            ContentCheck::Match
        ));
        assert!(matches!(
            check_file(
                &path,
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            ),
            ContentCheck::Mismatch { .. }
        ));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn persisted_digest_detects_same_size_edit_with_restored_write_time() {
        let dir = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("model.gguf");
        std::fs::write(&path, b"abc").unwrap();
        let modified = std::fs::metadata(&path).unwrap().modified().unwrap();
        let digest = DigestCache::open(&dir).digest(&path).unwrap();
        let reopened = DigestCache::open(&dir);
        assert_eq!(reopened.lookup(&path).as_deref(), Some(digest.as_str()));
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(&path, b"xyz").unwrap();
        File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(modified)
            .unwrap();
        assert_eq!(reopened.lookup(&path), None);
        assert_ne!(reopened.digest(&path).unwrap(), digest);
        let _ = std::fs::remove_dir_all(dir);
    }
}
