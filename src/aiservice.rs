use anyhow::{Context, Result};
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;

/// AI 服务子进程管理
static AI_PROCESS: Mutex<Option<Child>> = Mutex::new(None);

/// 临时解压目录（用于清理）
static AI_TEMP_DIR: Mutex<Option<PathBuf>> = Mutex::new(None);

/// 尝试启动 AI 服务（Node.js 子进程）
pub fn spawn_if_enabled() -> Result<()> {
    // 检查 Node.js 是否可用
    if Command::new("node").arg("--version").output().is_err() {
        eprintln!("[AI] 未检测到 Node.js，AI 功能不可用。安装 Node.js ≥20 后可使用。");
        return Ok(());
    }

    match start() {
        Ok(()) => {
            eprintln!("[AI] AI 服务子进程已启动");
            Ok(())
        }
        Err(e) => {
            eprintln!("[AI] AI 服务启动失败: {e:#}");
            Ok(()) // 不阻塞主程序
        }
    }
}

fn start() -> Result<()> {
    // 从嵌入式资源中解压 AI bundle 到临时目录
    let embedded = crate::ui::AiAssets::get("index.cjs")
        .context("AI 服务未内嵌（构建前请执行 cd ai && npm run bundle）")?;

    // 在系统临时目录创建 sup-ai 专用目录
    let tmp_dir = std::env::temp_dir().join(format!("sup-ai-{}", std::process::id()));
    let _ = fs::remove_dir_all(&tmp_dir); // 清理上次残留
    fs::create_dir_all(&tmp_dir).context("无法创建 AI 临时目录")?;

    let bundle_path = tmp_dir.join("index.cjs");
    let mut f = fs::File::create(&bundle_path).context("无法创建 AI bundle 文件")?;
    f.write_all(&embedded.data)
        .context("无法写入 AI bundle")?;
    drop(f);

    let child = Command::new("node")
        .arg(&bundle_path)
        .current_dir(&tmp_dir)
        .spawn()
        .context("无法启动 AI 服务子进程")?;

    *AI_PROCESS.lock().unwrap() = Some(child);
    *AI_TEMP_DIR.lock().unwrap() = Some(tmp_dir);
    Ok(())
}
