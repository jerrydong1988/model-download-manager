//! 下载完成后的内容校验。只保存并比对 sha256，不阻塞下载队列。

use std::fs::File;
use std::io::Read;
use std::path::Path;

use sha2::{Digest, Sha256};

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
    let mut file = File::open(path).map_err(|error| format!("无法读取文件以校验：{error}"))?;
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

pub enum ContentCheck {
    Match,
    Mismatch { actual: String },
    Unreadable { message: String },
}

pub fn check_file(path: &Path, expected: &str) -> ContentCheck {
    let Some(expected) = normalize_sha256(expected) else {
        return ContentCheck::Unreadable {
            message: "校验和格式无效".to_string(),
        };
    };
    match sha256_file(path) {
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
        assert_eq!(normalize_sha256(&format!("sha256:{hex}")).as_deref(), Some(hex));
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
        let digest = sha256_file(&path).unwrap();
        assert_eq!(
            digest,
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert!(matches!(check_file(&path, &digest), ContentCheck::Match));
        assert!(matches!(
            check_file(&path, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
            ContentCheck::Mismatch { .. }
        ));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
