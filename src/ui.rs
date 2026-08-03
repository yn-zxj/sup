use crate::approval;
use crate::config::{self, HostConfig};
use crate::fileops;
use crate::logdb;
use crate::push;
use crate::sshconn;
use anyhow::Result;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query};
use axum::http::{header, StatusCode, Uri};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use futures::stream::Stream;
use rust_embed::RustEmbed;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

#[derive(RustEmbed)]
#[folder = "web/dist"]
struct Assets;

#[derive(RustEmbed)]
#[folder = "ai/dist"]
pub(crate) struct AiAssets;

struct AppError(anyhow::Error);

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": format!("{:#}", self.0) })),
        )
            .into_response()
    }
}

impl<E: Into<anyhow::Error>> From<E> for AppError {
    fn from(e: E) -> Self {
        AppError(e.into())
    }
}

type ApiResult<T> = std::result::Result<T, AppError>;

pub fn run(port: u16) -> Result<()> {
    let rt = tokio::runtime::Runtime::new()?;
    rt.block_on(serve(port))
}

async fn serve(port: u16) -> Result<()> {
    // 记录端口号，供后续重启 AI 服务使用
    crate::aiservice::set_backend_port(port);

    // 在后台尝试启动 AI 服务（不阻塞 Web 启动）
    let port2 = port;
    tokio::task::spawn_blocking(move || {
        let _ = crate::aiservice::spawn_if_enabled(port2);
    });

    // 后台定期清理超时审批
    tokio::spawn(async {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            let _ = tokio::task::spawn_blocking(|| approval::pending_approvals()).await;
        }
    });

    let app = Router::new()
        .route("/api/hosts", get(hosts_list).post(hosts_save))
        .route("/api/hosts/:name", delete(hosts_delete))
        .route("/api/hosts/:name/test", post(hosts_test))
        .route("/api/hosts/export", get(hosts_export))
        .route("/api/hosts/import", post(hosts_import))
        .route("/api/presets", get(presets_list).post(presets_save))
        .route("/api/presets/:name", delete(presets_delete))
        .route("/api/logs", get(logs_list))
        .route("/api/logs/:id", get(logs_show))
        .route("/api/push/validate", post(push_validate))
        .route("/api/push/run", post(push_run))
        .route("/api/push/status/:id", get(push_status))
        .route("/api/term/:name", get(term_ws))
        .route("/api/files/:host/list", get(files_list))
        .route("/api/files/:host/read", get(files_read))
        .route("/api/files/:host/write", post(files_write))
        .route("/api/files/:host/stat", get(files_stat))
        .route("/api/ai/stream/:host", get(ai_stream_ws))
        .route("/api/ai/exec-command", post(ai_exec_command))
        .route("/api/ai/request-approval", post(ai_request_approval))
        .route("/api/ai/approvals", get(ai_list_approvals))
        .route("/api/ai/approvals-stream", get(ai_approvals_sse))
        .route("/api/ai/approve/:id", post(ai_approve))
        .route("/api/ai/reject/:id", post(ai_reject))
        .route("/api/ai/chat-stream", post(ai_chat_stream))
        .route("/api/ai/config", get(ai_get_config).post(ai_save_config))
        .fallback(static_handler);

    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await?;
    let url = format!("http://127.0.0.1:{port}");
    println!("sup Web UI 已启动: {url} （Ctrl+C 退出）");
    let _ = open::that(&url);
    axum::serve(listener, app).await?;
    Ok(())
}

// ---------- hosts ----------

#[derive(Serialize)]
struct HostItem {
    name: String,
    host: String,
    port: u16,
    user: String,
    auth: &'static str,
    remote_root: Option<String>,
    note: Option<String>,
}

async fn hosts_list() -> ApiResult<Json<Vec<HostItem>>> {
    let hosts = tokio::task::spawn_blocking(config::load_hosts).await??;
    let items = hosts
        .into_iter()
        .map(|(name, c)| HostItem {
            name,
            auth: if c.key_path.is_some() { "key" } else { "password" },
            host: c.host,
            port: c.port,
            user: c.user,
            remote_root: c.remote_root,
            note: c.note,
        })
        .collect();
    Ok(Json(items))
}

#[derive(Deserialize)]
struct SaveHostReq {
    name: String,
    host: String,
    #[serde(default = "default_port")]
    port: u16,
    user: String,
    key_path: Option<String>,
    password: Option<String>,
    passphrase: Option<String>,
    remote_root: Option<String>,
    note: Option<String>,
}

fn default_port() -> u16 {
    22
}

async fn hosts_save(Json(req): Json<SaveHostReq>) -> ApiResult<Json<serde_json::Value>> {
    tokio::task::spawn_blocking(move || -> Result<()> {
        let mut hosts = config::load_hosts()?;
        hosts.insert(
            req.name.clone(),
            HostConfig {
                host: req.host,
                port: req.port,
                user: req.user,
                key_path: req.key_path.filter(|s| !s.is_empty()),
                remote_root: req.remote_root.filter(|s| !s.is_empty()),
                note: req.note.filter(|s| !s.is_empty()),
            },
        );
        config::save_hosts(&hosts)?;
        if let Some(p) = req.password.filter(|s| !s.is_empty()) {
            config::set_secret(&req.name, &p)?;
        }
        if let Some(p) = req.passphrase.filter(|s| !s.is_empty()) {
            config::set_secret(&format!("{}#passphrase", req.name), &p)?;
        }
        Ok(())
    })
    .await??;
    Ok(Json(json!({ "ok": true })))
}

async fn hosts_delete(Path(name): Path<String>) -> ApiResult<Json<serde_json::Value>> {
    tokio::task::spawn_blocking(move || -> Result<()> {
        let mut hosts = config::load_hosts()?;
        hosts.remove(&name);
        config::save_hosts(&hosts)?;
        config::delete_secret(&name);
        config::delete_secret(&format!("{name}#passphrase"));
        Ok(())
    })
    .await??;
    Ok(Json(json!({ "ok": true })))
}

async fn hosts_test(Path(name): Path<String>) -> ApiResult<Json<serde_json::Value>> {
    tokio::task::spawn_blocking(move || -> Result<()> {
        let cfg = config::get_host(&name)?;
        let cred = sshconn::resolve_cred_stored(&name, &cfg)?;
        sshconn::open_session(&cfg, &cred)?;
        Ok(())
    })
    .await??;
    Ok(Json(json!({ "ok": true })))
}

// ---------- hosts export / import ----------

/// 导出所有主机为 JSON（不含密码/密钥等敏感凭据）
async fn hosts_export() -> ApiResult<Json<serde_json::Value>> {
    let hosts = tokio::task::spawn_blocking(|| -> Result<serde_json::Value> {
        let cfg = config::load_hosts()?;
        let items: Vec<serde_json::Value> = cfg
            .into_iter()
            .map(|(name, h)| {
                json!({
                    "name": name,
                    "host": h.host,
                    "port": h.port,
                    "user": h.user,
                    "remote_root": h.remote_root,
                    "note": h.note,
                })
            })
            .collect();
        Ok(json!({
            "version": 1,
            "hosts": items,
        }))
    })
    .await??;
    Ok(Json(hosts))
}

/// 导入主机配置
#[derive(Deserialize)]
struct HostsImportReq {
    hosts: Vec<HostImportItem>,
    #[serde(default = "default_dup")]
    on_duplicate: String,
}

fn default_dup() -> String { "skip".into() }

#[derive(Deserialize)]
struct HostImportItem {
    name: String,
    host: String,
    #[serde(default = "default_import_port")]
    port: u16,
    user: String,
    remote_root: Option<String>,
    note: Option<String>,
}

fn default_import_port() -> u16 { 22 }

async fn hosts_import(Json(req): Json<HostsImportReq>) -> ApiResult<Json<serde_json::Value>> {
    let result = tokio::task::spawn_blocking(move || -> Result<serde_json::Value> {
        let mut existing = config::load_hosts()?;
        let mut imported = 0usize;
        let mut skipped = 0usize;
        let mut overwritten = 0usize;

        for item in req.hosts {
            let entry = config::HostConfig {
                host: item.host,
                port: item.port,
                user: item.user,
                key_path: None,
                remote_root: item.remote_root,
                note: item.note,
            };
            match existing.get(&item.name) {
                Some(_) => match req.on_duplicate.as_str() {
                    "overwrite" => {
                        existing.insert(item.name, entry);
                        overwritten += 1;
                    }
                    _ => { skipped += 1; }
                },
                None => {
                    existing.insert(item.name, entry);
                    imported += 1;
                }
            }
        }
        config::save_hosts(&existing)?;
        Ok(json!({
            "ok": true,
            "imported": imported,
            "skipped": skipped,
            "overwritten": overwritten,
        }))
    })
    .await??;
    Ok(Json(result))
}

// ---------- presets ----------

#[derive(Serialize)]
struct PresetItem {
    name: String,
    host: String,
    maps: Vec<MapPair>,
}

#[derive(Deserialize)]
struct SavePresetReq {
    name: String,
    host: String,
    maps: Vec<MapPair>,
}

async fn presets_list() -> ApiResult<Json<Vec<PresetItem>>> {
    let presets = tokio::task::spawn_blocking(config::load_presets).await??;
    let items = presets
        .into_iter()
        .map(|(name, p)| PresetItem {
            name,
            host: p.host,
            maps: p
                .maps
                .into_iter()
                .map(|m| MapPair { local: m.local, remote: m.remote })
                .collect(),
        })
        .collect();
    Ok(Json(items))
}

async fn presets_save(Json(req): Json<SavePresetReq>) -> ApiResult<Json<serde_json::Value>> {
    tokio::task::spawn_blocking(move || -> Result<()> {
        let name = req.name.trim().to_string();
        if name.is_empty() {
            anyhow::bail!("预设名称不能为空");
        }
        let maps: Vec<config::PresetMap> = req
            .maps
            .iter()
            .filter(|m| !m.local.trim().is_empty())
            .map(|m| config::PresetMap {
                local: m.local.trim().to_string(),
                remote: m.remote.trim().to_string(),
            })
            .collect();
        if maps.is_empty() {
            anyhow::bail!("预设至少需要一条上传映射");
        }
        let mut presets = config::load_presets()?;
        presets.insert(name, config::Preset { host: req.host, maps });
        config::save_presets(&presets)
    })
    .await??;
    Ok(Json(json!({ "ok": true })))
}

async fn presets_delete(Path(name): Path<String>) -> ApiResult<Json<serde_json::Value>> {
    tokio::task::spawn_blocking(move || -> Result<()> {
        let mut presets = config::load_presets()?;
        presets.remove(&name);
        config::save_presets(&presets)
    })
    .await??;
    Ok(Json(json!({ "ok": true })))
}

// ---------- logs ----------

#[derive(Deserialize)]
struct LogQuery {
    host: Option<String>,
    #[serde(default)]
    failed: bool,
    #[serde(default = "default_limit")]
    limit: usize,
}

fn default_limit() -> usize {
    50
}

async fn logs_list(Query(q): Query<LogQuery>) -> ApiResult<Json<Vec<logdb::TaskRow>>> {
    let rows =
        tokio::task::spawn_blocking(move || logdb::list_tasks(q.host.as_deref(), q.failed, q.limit))
            .await??;
    Ok(Json(rows))
}

async fn logs_show(Path(id): Path<i64>) -> ApiResult<Json<serde_json::Value>> {
    let (task, files) = tokio::task::spawn_blocking(move || logdb::task_detail(id)).await??;
    Ok(Json(json!({ "task": task, "files": files })))
}

// ---------- push ----------

#[derive(Deserialize, Clone)]
struct PushReq {
    host: String,
    maps: Vec<MapPair>,
}

#[derive(Serialize, Deserialize, Clone)]
struct MapPair {
    local: String,
    #[serde(default)]
    remote: String,
}

#[derive(Serialize)]
struct ValidateResp {
    entries: Vec<EntryItem>,
    missing: Vec<String>,
}

#[derive(Serialize)]
struct EntryItem {
    local: String,
    remote: String,
    size: u64,
}

fn build_specs(req: &PushReq) -> Result<(Vec<push::Entry>, Vec<String>)> {
    let cfg = config::get_host(&req.host)?;
    let maps: Vec<String> = req
        .maps
        .iter()
        .map(|m| {
            let (local, remote) = (m.local.trim(), m.remote.trim());
            if remote.is_empty() {
                local.to_string()
            } else {
                format!("{local}:{remote}")
            }
        })
        .collect();
    push::collect(&maps, None, cfg.remote_root.as_deref())
}

async fn push_validate(Json(req): Json<PushReq>) -> ApiResult<Json<ValidateResp>> {
    let (entries, missing) = tokio::task::spawn_blocking(move || build_specs(&req)).await??;
    Ok(Json(ValidateResp {
        entries: entries
            .into_iter()
            .map(|e| EntryItem {
                local: e.local.display().to_string(),
                remote: e.remote,
                size: e.size,
            })
            .collect(),
        missing,
    }))
}

#[derive(Serialize, Clone, Default)]
struct RunStatus {
    total: usize,
    done: usize,
    ok: usize,
    failed: usize,
    bytes_total: u64,
    bytes_done: u64,
    current: String,
    finished: bool,
    task_id: Option<i64>,
    failures: Vec<FailItem>,
    error: Option<String>,
}

#[derive(Serialize, Clone)]
struct FailItem {
    local: String,
    error: String,
}

static RUNS: OnceLock<Mutex<HashMap<u64, RunStatus>>> = OnceLock::new();
static NEXT_RUN: AtomicU64 = AtomicU64::new(1);

fn runs() -> &'static Mutex<HashMap<u64, RunStatus>> {
    RUNS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn with_run(id: u64, f: impl FnOnce(&mut RunStatus)) {
    if let Some(s) = runs().lock().unwrap().get_mut(&id) {
        f(s);
    }
}

async fn push_run(Json(req): Json<PushReq>) -> ApiResult<Json<serde_json::Value>> {
    let name = req.host.clone();
    let (entries, missing) = tokio::task::spawn_blocking(move || build_specs(&req)).await??;
    if entries.is_empty() {
        return Err(anyhow::anyhow!("没有可上传的文件").into());
    }
    let run_id = NEXT_RUN.fetch_add(1, Ordering::SeqCst);
    let status = RunStatus {
        total: entries.len(),
        bytes_total: entries.iter().map(|e| e.size).sum(),
        ..Default::default()
    };
    runs().lock().unwrap().insert(run_id, status);
    std::thread::spawn(move || do_push(run_id, name, entries, missing));
    Ok(Json(json!({ "run_id": run_id })))
}

async fn push_status(Path(id): Path<u64>) -> ApiResult<Json<RunStatus>> {
    let s = runs()
        .lock()
        .unwrap()
        .get(&id)
        .cloned()
        .ok_or_else(|| anyhow::anyhow!("run {id} 不存在"))?;
    Ok(Json(s))
}

fn do_push(run_id: u64, name: String, entries: Vec<push::Entry>, missing: Vec<String>) {
    let result = (|| -> Result<()> {
        let cfg = config::get_host(&name)?;
        let cred = sshconn::resolve_cred_stored(&name, &cfg)?;
        let db = logdb::open()?;
        let task_id = logdb::start_task(&db, &name, entries.len() + missing.len())?;
        with_run(run_id, |s| s.task_id = Some(task_id));
        for m in &missing {
            logdb::add_file(&db, task_id, m, "-", 0, "skipped", Some("本地文件不存在"), 0)?;
        }
        let started = Instant::now();
        let sess = sshconn::open_session(&cfg, &cred)?;
        let sftp = sess.sftp()?;
        let mut created = HashSet::new();
        let (mut ok, mut failed) = (0usize, 0usize);
        for e in &entries {
            with_run(run_id, |s| s.current = e.local.display().to_string());
            let t = Instant::now();
            let mut r = Ok(());
            for _attempt in 0..=2u32 {
                r = push::upload_one(
                    &sftp,
                    e,
                    &mut |n| with_run(run_id, |s| s.bytes_done += n),
                    &mut created,
                )
                .map_err(|err| format!("{err:#}"));
                if r.is_ok() {
                    break;
                }
            }
            let local = e.local.display().to_string();
            match &r {
                Ok(()) => {
                    ok += 1;
                    logdb::add_file(&db, task_id, &local, &e.remote, e.size, "ok", None, t.elapsed().as_millis())?;
                }
                Err(err) => {
                    failed += 1;
                    logdb::add_file(&db, task_id, &local, &e.remote, e.size, "failed", Some(err), t.elapsed().as_millis())?;
                    with_run(run_id, |s| {
                        s.failures.push(FailItem { local: local.clone(), error: err.clone() })
                    });
                }
            }
            with_run(run_id, |s| {
                s.done += 1;
                s.ok = ok;
                s.failed = failed;
            });
        }
        logdb::finish_task(&db, task_id, ok, failed, missing.len(), started.elapsed().as_millis())?;
        Ok(())
    })();
    with_run(run_id, |s| {
        s.finished = true;
        if let Err(e) = result {
            s.error = Some(format!("{e:#}"));
        }
    });
}

// ---------- terminal websocket ----------

enum TermMsg {
    Data(Vec<u8>),
    Resize(u32, u32),
}

async fn term_ws(ws: WebSocketUpgrade, Path(name): Path<String>) -> Response {
    ws.on_upgrade(move |socket| handle_term(socket, name))
}

async fn handle_term(mut socket: WebSocket, name: String) {
    let conn = tokio::task::spawn_blocking({
        let name = name.clone();
        move || -> Result<(ssh2::Session, ssh2::Channel)> {
            let cfg = config::get_host(&name)?;
            let cred = sshconn::resolve_cred_stored(&name, &cfg)?;
            let sess = sshconn::open_session(&cfg, &cred)?;
            let mut ch = sess.channel_session()?;
            ch.request_pty("xterm-256color", None, Some((100, 30, 0, 0)))?;
            ch.shell()?;
            sess.set_blocking(false);
            Ok((sess, ch))
        }
    })
    .await;

    let (sess, mut ch) = match conn {
        Ok(Ok(v)) => v,
        Ok(Err(e)) => {
            let _ = socket
                .send(Message::Text(format!("\r\n\x1b[31m连接失败: {e:#}\x1b[0m\r\n")))
                .await;
            return;
        }
        Err(e) => {
            let _ = socket.send(Message::Text(format!("\r\n内部错误: {e}\r\n"))).await;
            return;
        }
    };

    let (to_ssh_tx, to_ssh_rx) = std::sync::mpsc::channel::<TermMsg>();
    let (from_ssh_tx, mut from_ssh_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(64);

    std::thread::spawn(move || {
        let _sess = sess; // 保持会话存活
        let mut buf = [0u8; 8192];
        loop {
            let mut active = false;
            match std::io::Read::read(&mut ch, &mut buf) {
                Ok(0) => {
                    if ch.eof() {
                        break;
                    }
                }
                Ok(n) => {
                    if from_ssh_tx.blocking_send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                    active = true;
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
                Err(_) => break,
            }
            match to_ssh_rx.try_recv() {
                Ok(TermMsg::Data(mut data)) => {
                    let mut slice = &data[..];
                    while !slice.is_empty() {
                        match std::io::Write::write(&mut ch, slice) {
                            Ok(n) => slice = &slice[n..],
                            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                                std::thread::sleep(std::time::Duration::from_millis(2));
                            }
                            Err(_) => break,
                        }
                    }
                    data.clear();
                    active = true;
                }
                Ok(TermMsg::Resize(c, r)) => {
                    let _ = ch.request_pty_size(c, r, None, None);
                }
                Err(std::sync::mpsc::TryRecvError::Empty) => {}
                Err(std::sync::mpsc::TryRecvError::Disconnected) => break,
            }
            if ch.eof() {
                break;
            }
            if !active {
                std::thread::sleep(std::time::Duration::from_millis(8));
            }
        }
    });

    loop {
        tokio::select! {
            m = socket.recv() => match m {
                Some(Ok(Message::Binary(b))) => {
                    if to_ssh_tx.send(TermMsg::Data(b)).is_err() { break; }
                }
                Some(Ok(Message::Text(t))) => {
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&t) {
                        if let (Some(c), Some(r)) = (v["cols"].as_u64(), v["rows"].as_u64()) {
                            let _ = to_ssh_tx.send(TermMsg::Resize(c as u32, r as u32));
                            continue;
                        }
                    }
                    if to_ssh_tx.send(TermMsg::Data(t.into_bytes())).is_err() { break; }
                }
                Some(Ok(Message::Close(_))) | None => break,
                Some(Ok(_)) => {}
                Some(Err(_)) => break,
            },
            b = from_ssh_rx.recv() => match b {
                Some(b) => {
                    if socket.send(Message::Binary(b)).await.is_err() { break; }
                }
                None => break,
            },
        }
    }
}

// ---------- file operations (SFTP) ----------

#[derive(Deserialize)]
struct FilePathQuery {
    path: String,
}

#[derive(Deserialize)]
struct WriteFileReq {
    path: String,
    content: String,
}

async fn files_list(
    Path(host): Path<String>,
    Query(q): Query<FilePathQuery>,
) -> ApiResult<Json<serde_json::Value>> {
    let path = q.path.clone();
    let entries = tokio::task::spawn_blocking(move || -> Result<Vec<fileops::FileEntry>> {
        let cfg = config::get_host(&host)?;
        let cred = sshconn::resolve_cred_stored(&host, &cfg)?;
        let sess = sshconn::open_session(&cfg, &cred)?;
        let sftp = sess.sftp()?;
        fileops::list_dir(&sftp, &path)
    })
    .await??;
    Ok(Json(json!({ "entries": entries })))
}

async fn files_read(
    Path(host): Path<String>,
    Query(q): Query<FilePathQuery>,
) -> ApiResult<Json<serde_json::Value>> {
    let path = q.path.clone();
    let content = tokio::task::spawn_blocking(move || -> Result<String> {
        let cfg = config::get_host(&host)?;
        let cred = sshconn::resolve_cred_stored(&host, &cfg)?;
        let sess = sshconn::open_session(&cfg, &cred)?;
        let sftp = sess.sftp()?;
        fileops::read_file(&sftp, &path)
    })
    .await??;
    Ok(Json(json!({ "content": content, "size": content.len() })))
}

async fn files_write(
    Path(host): Path<String>,
    Json(req): Json<WriteFileReq>,
) -> ApiResult<Json<serde_json::Value>> {
    let path = req.path.clone();
    let content = req.content.clone();
    tokio::task::spawn_blocking(move || -> Result<()> {
        let cfg = config::get_host(&host)?;
        let cred = sshconn::resolve_cred_stored(&host, &cfg)?;
        let sess = sshconn::open_session(&cfg, &cred)?;
        let sftp = sess.sftp()?;
        fileops::write_file(&sftp, &path, &content)
    })
    .await??;
    Ok(Json(json!({ "ok": true })))
}

async fn files_stat(
    Path(host): Path<String>,
    Query(q): Query<FilePathQuery>,
) -> ApiResult<Json<serde_json::Value>> {
    let path = q.path.clone();
    let stat = tokio::task::spawn_blocking(move || -> Result<fileops::FileStat> {
        let cfg = config::get_host(&host)?;
        let cred = sshconn::resolve_cred_stored(&host, &cfg)?;
        let sess = sshconn::open_session(&cfg, &cred)?;
        let sftp = sess.sftp()?;
        fileops::stat_path(&sftp, &path)
    })
    .await??;
    Ok(Json(json!({ "stat": stat })))
}

// ---------- AI routes ----------

#[derive(Deserialize)]
struct AiExecReq {
    host: String,
    command: String,
}

#[derive(Deserialize)]
struct AiApprovalReq {
    host: String,
    command: String,
}

async fn ai_stream_ws(ws: WebSocketUpgrade, Path(host): Path<String>) -> Response {
    ws.on_upgrade(move |socket| handle_ai_stream(socket, host))
}

async fn handle_ai_stream(mut socket: WebSocket, _host: String) {
    use tokio::sync::mpsc;
    let (tx, mut rx) = mpsc::channel::<String>(32);
    let send_handle = tokio::spawn(async move {
        while let Some(Ok(msg)) = socket.recv().await {
            match msg {
                Message::Text(t) => {
                    if tx.send(t).await.is_err() {
                        break;
                    }
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
    });
    let _ = send_handle.await;
    while rx.try_recv().is_ok() {}
}

async fn ai_exec_command(Json(req): Json<AiExecReq>) -> ApiResult<Json<serde_json::Value>> {
    let host = req.host.clone();
    let command = req.command.clone();
    let risk = approval::classify_risk(&command);
    if risk == approval::RiskLevel::Dangerous {
        let (_approval_id, rx) = approval::submit_approval(&host, &command);
        let result = tokio::time::timeout(std::time::Duration::from_secs(35), rx).await;
        match result {
            Ok(Ok(r)) if r.approved => {}
            Ok(Ok(r)) => {
                return Ok(Json(json!({
                    "stdout": "",
                    "stderr": r.rejected_reason.unwrap_or("已拒绝".to_string()),
                    "exit_code": 1
                })));
            }
            _ => {
                return Ok(Json(json!({
                    "stdout": "",
                    "stderr": "审批超时或已取消".to_string(),
                    "exit_code": 1
                })));
            }
        }
    }
    let output = tokio::task::spawn_blocking(move || -> Result<(String, String, i32)> {
        let cfg = config::get_host(&host)?;
        let cred = sshconn::resolve_cred_stored(&host, &cfg)?;
        let sess = sshconn::open_session(&cfg, &cred)?;
        let mut ch = sess.channel_session()?;
        ch.exec(&command)?;
        let mut stdout = String::new();
        let mut stderr = String::new();
        ch.read_to_string(&mut stdout)?;
        ch.stderr().read_to_string(&mut stderr)?;
        ch.wait_close()?;
        let exit_code = ch.exit_status()?;
        Ok((stdout, stderr, exit_code))
    })
    .await??;
    Ok(Json(json!({
        "stdout": output.0,
        "stderr": output.1,
        "exit_code": output.2
    })))
}

async fn ai_request_approval(
    Json(req): Json<AiApprovalReq>,
) -> ApiResult<Json<serde_json::Value>> {
    let (id, rx) = approval::submit_approval(&req.host, &req.command);
    let result = tokio::time::timeout(std::time::Duration::from_secs(35), rx).await;
    match result {
        Ok(Ok(r)) => Ok(Json(json!({
            "result": {
                "id": r.id,
                "approved": r.approved,
                "rejected_reason": r.rejected_reason
            }
        }))),
        _ => Ok(Json(json!({
            "result": {
                "id": id,
                "approved": false,
                "rejected_reason": "审批超时"
            }
        }))),
    }
}

/// SSE 审批事件流（替代轮询 /api/ai/approvals）
async fn ai_approvals_sse() -> Sse<impl Stream<Item = std::result::Result<Event, std::convert::Infallible>>> {
    use futures::StreamExt;
    use tokio_stream::wrappers::BroadcastStream;

    // 先发送当前待审批列表
    let initial = tokio::task::spawn_blocking(approval::pending_approvals)
        .await
        .unwrap_or_default();

    let initial_stream = futures::stream::iter(
        initial.into_iter().map(|req| {
            Ok(Event::default()
                .event("new")
                .data(serde_json::to_string(&req).unwrap_or_default()))
        }),
    );

    // 订阅后续事件
    let rx = approval::subscribe_events();
    let event_stream = BroadcastStream::new(rx).filter_map(|result| {
        futures::future::ready(match result {
            Ok(event) => {
                let json = serde_json::to_string(&event).unwrap_or_default();
                let event_type = match &event {
                    approval::ApprovalEvent::New(_) => "new",
                    approval::ApprovalEvent::Approved { .. } => "approved",
                    approval::ApprovalEvent::Rejected { .. } => "rejected",
                };
                Some(Ok(Event::default().event(event_type).data(json)))
            }
            Err(_) => None, // 跳过 lagged 事件
        })
    });

    let stream = initial_stream.chain(event_stream);
    Sse::new(stream).keep_alive(KeepAlive::default())
}

async fn ai_list_approvals() -> ApiResult<Json<Vec<approval::ApprovalRequest>>> {
    Ok(Json(approval::pending_approvals()))
}

async fn ai_approve(Path(id): Path<String>) -> ApiResult<Json<serde_json::Value>> {
    let ok = approval::approve(&id);
    Ok(Json(json!({ "ok": ok })))
}

#[derive(Deserialize)]
struct RejectBody {
    reason: Option<String>,
}

async fn ai_reject(
    Path(id): Path<String>,
    Json(body): Json<RejectBody>,
) -> ApiResult<Json<serde_json::Value>> {
    let ok = approval::reject(&id, body.reason);
    Ok(Json(json!({ "ok": ok })))
}

/// SSE 代理：转发聊天请求到 AI Service
async fn ai_chat_stream(
    Json(req): Json<serde_json::Value>,
) -> Response {
    use axum::http::StatusCode;
    use axum::body::Body;
    use futures::StreamExt;

    let ai_port = 7799u16;
    let ai_url = format!("http://127.0.0.1:{ai_port}/chat/stream");

    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": format!("AI 客户端初始化失败: {e}") })),
            )
                .into_response();
        }
    };

    match client.post(&ai_url).json(&req).send().await {
        Ok(resp) if resp.status().is_success() => {
            let headers = [
                (header::CONTENT_TYPE, "text/event-stream"),
                (header::CACHE_CONTROL, "no-cache"),
            ];
            let stream = resp.bytes_stream().map(|r| {
                r.map(|b| axum::body::Bytes::from(b.to_vec()))
                    .map_err(std::io::Error::other)
            });
            let body = Body::from_stream(stream);
            (StatusCode::OK, headers, body).into_response()
        }
        Ok(resp) => {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            (
                status,
                Json(json!({ "error": body })),
            )
                .into_response()
        }
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": format!("AI 服务不可用: {e}") })),
        )
            .into_response(),
    }
}

/// 获取 AI 配置（api_key 用占位符，不泄露）
async fn ai_get_config() -> ApiResult<Json<serde_json::Value>> {
    let cfg = tokio::task::spawn_blocking(config::load_ai_config).await??;
    let has_key = config::get_ai_api_key().is_some();
    Ok(Json(json!({
        "enabled": cfg.enabled,
        "provider": cfg.provider,
        "base_url": cfg.base_url,
        "model": cfg.model,
        "port": cfg.port,
        "has_api_key": has_key,
    })))
}

/// 保存 AI 配置
#[derive(Deserialize)]
struct AiConfigReq {
    enabled: Option<bool>,
    provider: Option<String>,
    base_url: Option<String>,
    model: Option<String>,
    port: Option<u16>,
    api_key: Option<String>,
}

async fn ai_save_config(Json(req): Json<AiConfigReq>) -> ApiResult<Json<serde_json::Value>> {
    tokio::task::spawn_blocking(move || -> Result<()> {
        let mut cfg = config::load_ai_config()?;
        if let Some(v) = req.enabled { cfg.enabled = v; }
        if let Some(v) = req.provider { cfg.provider = v; }
        if let Some(v) = req.base_url { cfg.base_url = v; }
        if let Some(v) = req.model { cfg.model = v; }
        if let Some(v) = req.port { cfg.port = v; }
        config::save_ai_config(&cfg)?;
        // API Key 单独存钥匙串
        if let Some(key) = req.api_key {
            if key.is_empty() {
                config::delete_ai_api_key();
            } else {
                config::set_ai_api_key(&key)?;
            }
        }
        Ok(())
    })
    .await??;

    // 配置变更后重启 AI 服务，使新配置（尤其是 API Key）生效
    tokio::task::spawn_blocking(|| {
        crate::aiservice::restart_ai_service();
    });

    Ok(Json(json!({ "ok": true })))
}

// ---------- static assets ----------

async fn static_handler(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };
    serve_asset(path)
        .or_else(|| serve_asset("index.html"))
        .unwrap_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                "前端资源未构建：请在 web/ 目录运行 npm run build 后重新编译",
            )
                .into_response()
        })
}

fn serve_asset(path: &str) -> Option<Response> {
    let f = Assets::get(path)?;
    let mime = mime_guess::from_path(path).first_or_octet_stream();
    Some(
        (
            [(header::CONTENT_TYPE, mime.as_ref().to_string())],
            f.data.into_owned(),
        )
            .into_response(),
    )
}
