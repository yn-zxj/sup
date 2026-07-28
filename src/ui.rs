use crate::config::{self, HostConfig};
use crate::logdb;
use crate::push;
use crate::sshconn;
use anyhow::Result;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query};
use axum::http::{header, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use rust_embed::RustEmbed;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

#[derive(RustEmbed)]
#[folder = "web/dist"]
struct Assets;

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
    let app = Router::new()
        .route("/api/hosts", get(hosts_list).post(hosts_save))
        .route("/api/hosts/:name", delete(hosts_delete))
        .route("/api/hosts/:name/test", post(hosts_test))
        .route("/api/presets", get(presets_list).post(presets_save))
        .route("/api/presets/:name", delete(presets_delete))
        .route("/api/logs", get(logs_list))
        .route("/api/logs/:id", get(logs_show))
        .route("/api/push/validate", post(push_validate))
        .route("/api/push/run", post(push_run))
        .route("/api/push/status/:id", get(push_status))
        .route("/api/term/:name", get(term_ws))
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
