use anyhow::{Context, Result};
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::Duration;

/// AI 服务子进程管理
static AI_PROCESS: Mutex<Option<Child>> = Mutex::new(None);

/// 临时解压目录（用于清理）
static AI_TEMP_DIR: Mutex<Option<PathBuf>> = Mutex::new(None);

/// 后端端口号（重启 AI 服务时需要）
static BACKEND_PORT: Mutex<u16> = Mutex::new(7788);

/// 记录后端端口号
pub fn set_backend_port(port: u16) {
    *BACKEND_PORT.lock().unwrap() = port;
}

/// 终止当前 AI 服务子进程（如果有）
pub fn kill_ai_service() {
    if let Some(mut child) = AI_PROCESS.lock().unwrap().take() {
        let _ = child.kill();
        let _ = child.wait();
        eprintln!("[AI] 已终止旧 AI 服务进程");
    }
    // 清理临时目录
    if let Some(dir) = AI_TEMP_DIR.lock().unwrap().take() {
        let _ = fs::remove_dir_all(&dir);
    }
}

/// 重启 AI 服务（先杀旧进程，再启动新的）
pub fn restart_ai_service() {
    kill_ai_service();
    let port = *BACKEND_PORT.lock().unwrap();
    let _ = spawn_if_enabled(port);
}

/// 尝试启动 AI 服务（Node.js 子进程）
///
/// `backend_port` 为 Web UI 端口号，AI 服务通过此端口回调 Rust 后端执行命令等
pub fn spawn_if_enabled(backend_port: u16) -> Result<()> {
    // 如果已有 AI 进程在运行，跳过
    if AI_PROCESS.lock().unwrap().is_some() {
        return Ok(());
    }
    // 检查 Node.js 是否可用（超时 3 秒）
    let node_ok = std::thread::spawn(|| Command::new("node").arg("--version").output().is_ok())
        .join()
        .unwrap_or(false);
    if !node_ok {
        eprintln!("[AI] 未检测到 Node.js，AI 功能不可用。安装 Node.js ≥20 后可使用。");
        return Ok(());
    }

    // 加载 AI 配置
    let ai_cfg = match crate::config::load_ai_config() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[AI] 加载 AI 配置失败: {e:#}");
            return Ok(());
        }
    };

    if !ai_cfg.enabled {
        eprintln!("[AI] AI 功能已禁用（ai.toml 中 enabled = false）");
        return Ok(());
    }

    // 尝试读取 API Key（env var 优先，钥匙串次之，加 2s 超时防阻塞）
    let api_key = std::env::var("OPENAI_API_KEY").ok().or_else(|| {
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send(crate::config::get_ai_api_key());
        });
        rx.recv_timeout(Duration::from_secs(2)).ok().flatten()
    }).unwrap_or_default();

    if api_key.is_empty() {
        eprintln!("[AI] ⚠️  未配置 API Key，AI 功能无法使用");
        eprintln!("[AI] 请在 Web UI「AI 设置」中配置，或设置环境变量 OPENAI_API_KEY");
    }

    match start(&ai_cfg, &api_key, backend_port) {
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

fn start(ai_cfg: &crate::config::AiConfig, api_key: &str, backend_port: u16) -> Result<()> {
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
        .arg("--no-deprecation")
        .arg(&bundle_path)
        .current_dir(&tmp_dir)
        .env("SUP_AI_PROVIDER", &ai_cfg.provider)
        .env("SUP_AI_BASE_URL", &ai_cfg.base_url)
        .env("SUP_AI_MODEL", &ai_cfg.model)
        .env("SUP_AI_PORT", ai_cfg.port.to_string())
        .env("SUP_AI_API_KEY", api_key)
        .env("SUP_BACKEND_URL", format!("http://127.0.0.1:{backend_port}"))
        .env("SUP_AI_ENABLED", ai_cfg.enabled.to_string())
        .spawn()
        .context("无法启动 AI 服务子进程")?;

    *AI_PROCESS.lock().unwrap() = Some(child);
    *AI_TEMP_DIR.lock().unwrap() = Some(tmp_dir);
    Ok(())
}
