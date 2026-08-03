use anyhow::{bail, Context, Result};
use serde::Serialize;
use ssh2::Sftp;
use std::io::{Read, Write};
use std::path::Path;

#[derive(Debug, Serialize, Clone)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub is_dir: bool,
    pub mode: u32,
    pub modified: i64,
}

#[derive(Debug, Serialize)]
pub struct FileStat {
    pub size: u64,
    pub is_dir: bool,
    pub mode: u32,
    pub modified: i64,
}

/// 列出远程目录内容，不包含 . 和 ..
pub fn list_dir(sftp: &Sftp, remote_path: &str) -> Result<Vec<FileEntry>> {
    let path = Path::new(remote_path);
    let entries = sftp
        .readdir(path)
        .with_context(|| format!("列出目录失败: {remote_path}"))?;

    let mut result = Vec::new();
    for (p, stat) in entries {
        let name = p
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        // 跳过 . 和 ..
        if name == "." || name == ".." {
            continue;
        }
        let full = if remote_path.ends_with('/') {
            format!("{remote_path}{name}")
        } else {
            format!("{remote_path}/{name}")
        };
        result.push(FileEntry {
            name,
            path: full,
            size: stat.size.unwrap_or(0),
            is_dir: stat.is_dir(),
            mode: stat.perm.unwrap_or(0),
            modified: stat.mtime.unwrap_or(0) as i64,
        });
    }
    // 目录优先，文件名排序
    result.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.cmp(&b.name)));
    Ok(result)
}

/// 读取远程文本文件内容（限制最大 10MB）
const MAX_READ_SIZE: u64 = 10 * 1024 * 1024;

pub fn read_file(sftp: &Sftp, remote_path: &str) -> Result<String> {
    let path = Path::new(remote_path);
    let stat = sftp
        .stat(path)
        .with_context(|| format!("读取文件信息失败: {remote_path}"))?;

    if stat.is_dir() {
        bail!("{remote_path} 是一个目录，无法读取");
    }
    let size = stat.size.unwrap_or(0);
    if size > MAX_READ_SIZE {
        bail!(
            "文件过大（{:.1}MB），超过最大限制 10MB，请通过终端编辑",
            size as f64 / 1024.0 / 1024.0
        );
    }

    let mut remote_file = sftp
        .open(path)
        .with_context(|| format!("打开远程文件失败: {remote_path}"))?;

    let mut buf = if size > 0 {
        Vec::with_capacity(size as usize)
    } else {
        Vec::new()
    };
    remote_file
        .read_to_end(&mut buf)
        .with_context(|| format!("读取远程文件失败: {remote_path}"))?;

    // 去除 null 字节（非文本文件可能会有）
    if buf.contains(&0) {
        bail!("{remote_path} 似乎是二进制文件，不支持编辑");
    }

    String::from_utf8(buf).context("文件编码不是有效的 UTF-8")
}

/// 写入远程文件：先写临时文件，成功后再 rename（原子操作）
pub fn write_file(sftp: &Sftp, remote_path: &str, content: &str) -> Result<()> {
    let path = Path::new(remote_path);

    // 检查是否是目录
    if let Ok(stat) = sftp.stat(path) {
        if stat.is_dir() {
            bail!("{remote_path} 是一个目录，无法写入");
        }
    }

    // 写临时文件
    let tmp_path = format!("{remote_path}.sup-tmp-{}", std::process::id());
    {
        let mut tmp_file = sftp
            .create(Path::new(&tmp_path))
            .with_context(|| format!("创建临时文件失败: {tmp_path}"))?;
        tmp_file
            .write_all(content.as_bytes())
            .with_context(|| format!("写入临时文件失败: {tmp_path}"))?;
        // 确保写入完成
        tmp_file.flush().ok();
    }

    // 重命名临时文件 → 目标文件
    sftp.rename(Path::new(&tmp_path), path, None)
        .or_else(|_| {
            // 如果 rename 不支持跨文件系统，尝试删除目标再 rename
            let _ = sftp.unlink(path);
            sftp.rename(Path::new(&tmp_path), path, None)
        })
        .with_context(|| format!("保存文件失败: {remote_path}"))?;

    Ok(())
}

/// 获取远程文件/目录信息
pub fn stat_path(sftp: &Sftp, remote_path: &str) -> Result<FileStat> {
    let path = Path::new(remote_path);
    let stat = sftp
        .stat(path)
        .with_context(|| format!("获取文件信息失败: {remote_path}"))?;

    Ok(FileStat {
        size: stat.size.unwrap_or(0),
        is_dir: stat.is_dir(),
        mode: stat.perm.unwrap_or(0),
        modified: stat.mtime.unwrap_or(0) as i64,
    })
}
