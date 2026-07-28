use crate::config::{self, HostConfig};
use crate::logdb;
use crate::sshconn::{self, Cred};
use anyhow::{bail, Context, Result};
use indicatif::{MultiProgress, ProgressBar, ProgressStyle};
use ssh2::Sftp;
use std::collections::{HashSet, VecDeque};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::Instant;

pub struct Options {
    pub yes: bool,
    pub concurrency: usize,
    pub retry: u32,
}

#[derive(Clone)]
pub struct Entry {
    pub local: PathBuf,
    pub remote: String,
    pub size: u64,
}

pub fn run(
    name: &str,
    maps: &[String],
    from_file: Option<&str>,
    remote_root: Option<&str>,
    opts: Options,
) -> Result<()> {
    let cfg = config::get_host(name)?;
    let remote_root = remote_root
        .map(str::to_string)
        .or_else(|| cfg.remote_root.clone());

    let (entries, missing) = collect(maps, from_file, remote_root.as_deref())?;

    if !missing.is_empty() {
        println!("\x1b[31m以下 {} 个本地文件不存在：\x1b[0m", missing.len());
        for m in &missing {
            println!("  \x1b[31m✗ {}\x1b[0m", m);
        }
        if entries.is_empty() {
            bail!("没有可上传的文件");
        }
        if !opts.yes {
            print!("剔除以上文件并继续上传其余 {} 个文件? [y/N] ", entries.len());
            std::io::stdout().flush()?;
            let mut line = String::new();
            std::io::stdin().read_line(&mut line)?;
            if !matches!(line.trim(), "y" | "Y" | "yes") {
                bail!("已取消上传");
            }
        } else {
            println!("(--yes 已自动剔除)");
        }
    }
    if entries.is_empty() {
        bail!("没有可上传的文件（请用 --map 本地:远程 或 --from-file 指定）");
    }

    let cred = sshconn::resolve_cred(name, &cfg)?;
    let db = logdb::open()?;
    let task_id = logdb::start_task(&db, name, entries.len() + missing.len())?;
    for m in &missing {
        logdb::add_file(&db, task_id, m, "-", 0, "skipped", Some("本地文件不存在"), 0)?;
    }

    let started = Instant::now();
    let total = entries.len();
    let workers = opts.concurrency.min(total);
    println!("开始上传 {total} 个文件到 `{name}`（并发 {workers}）...");

    let mp = MultiProgress::new();
    let overall = mp.add(ProgressBar::new(total as u64));
    overall.set_style(
        ProgressStyle::with_template("{bar:30.cyan/blue} {pos}/{len} 文件 {msg}")?,
    );

    let queue: Arc<Mutex<VecDeque<Entry>>> = Arc::new(Mutex::new(entries.clone().into()));
    let (tx, rx) = mpsc::channel::<(Entry, Result<(), String>, u128)>();

    let mut handles = Vec::new();
    for _ in 0..workers {
        let queue = Arc::clone(&queue);
        let tx = tx.clone();
        let cfg: HostConfig = cfg.clone();
        let cred: Cred = cred.clone();
        let mp = mp.clone();
        let retry = opts.retry;
        handles.push(thread::spawn(move || {
            let sess = match sshconn::open_session(&cfg, &cred) {
                Ok(s) => s,
                Err(e) => {
                    // 连接失败：把队列剩余任务都标记失败
                    while let Some(en) = queue.lock().unwrap().pop_front() {
                        let _ = tx.send((en, Err(format!("连接失败: {e}")), 0));
                    }
                    return;
                }
            };
            let sftp = match sess.sftp() {
                Ok(s) => s,
                Err(e) => {
                    while let Some(en) = queue.lock().unwrap().pop_front() {
                        let _ = tx.send((en, Err(format!("SFTP 初始化失败: {e}")), 0));
                    }
                    return;
                }
            };
            let mut created_dirs = HashSet::new();
            loop {
                let entry = match queue.lock().unwrap().pop_front() {
                    Some(e) => e,
                    None => break,
                };
                let bar = mp.add(ProgressBar::new(entry.size));
                bar.set_style(
                    ProgressStyle::with_template(
                        "  {bar:20.green} {bytes}/{total_bytes} {binary_bytes_per_sec} {msg}",
                    )
                    .unwrap(),
                );
                bar.set_message(
                    entry
                        .local
                        .file_name()
                        .map(|s| s.to_string_lossy().into_owned())
                        .unwrap_or_default(),
                );
                let t = Instant::now();
                let mut result = Ok(());
                for attempt in 0..=retry {
                    bar.set_position(0);
                    result = upload_one(&sftp, &entry, &mut |n| bar.inc(n), &mut created_dirs)
                        .map_err(|e| format!("{e:#}"));
                    if result.is_ok() {
                        break;
                    }
                    if attempt < retry {
                        bar.set_message(format!("重试 {}/{retry}", attempt + 1));
                    }
                }
                bar.finish_and_clear();
                let _ = tx.send((entry, result, t.elapsed().as_millis()));
            }
        }));
    }
    drop(tx);

    let mut ok = 0usize;
    let mut failed = 0usize;
    let mut failures: Vec<(String, String)> = Vec::new();
    for (entry, result, ms) in rx {
        let local = entry.local.display().to_string();
        match result {
            Ok(()) => {
                ok += 1;
                logdb::add_file(&db, task_id, &local, &entry.remote, entry.size, "ok", None, ms)?;
            }
            Err(e) => {
                failed += 1;
                logdb::add_file(
                    &db, task_id, &local, &entry.remote, entry.size, "failed", Some(&e), ms,
                )?;
                failures.push((local, e));
            }
        }
        overall.inc(1);
    }
    for h in handles {
        let _ = h.join();
    }
    overall.finish_and_clear();
    logdb::finish_task(&db, task_id, ok, failed, missing.len(), started.elapsed().as_millis())?;

    println!(
        "\n完成（任务 #{task_id}，耗时 {:.1}s）: \x1b[32m成功 {ok}\x1b[0m / \x1b[31m失败 {failed}\x1b[0m / \x1b[33m剔除 {}\x1b[0m",
        started.elapsed().as_secs_f32(),
        missing.len()
    );
    for (local, err) in &failures {
        println!("  \x1b[31m✗ {local}: {err}\x1b[0m");
    }
    println!("日志: sup log show {task_id}");
    if failed > 0 {
        bail!("{failed} 个文件上传失败");
    }
    Ok(())
}

pub fn collect(
    maps: &[String],
    from_file: Option<&str>,
    remote_root: Option<&str>,
) -> Result<(Vec<Entry>, Vec<String>)> {
    let mut specs: Vec<(String, Option<String>)> = Vec::new(); // (local, remote?)
    for m in maps {
        match m.split_once(':') {
            Some((l, r)) if !r.trim().is_empty() => {
                specs.push((l.to_string(), Some(r.trim().to_string())))
            }
            Some((l, _)) => specs.push((l.to_string(), None)),
            None => specs.push((m.clone(), None)),
        }
    }
    if let Some(f) = from_file {
        let content =
            fs::read_to_string(f).with_context(|| format!("无法读取列表文件 {f}"))?;
        for line in content.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            match line.split_once(':') {
                Some((l, r)) => specs.push((l.to_string(), Some(r.to_string()))),
                None => specs.push((line.to_string(), None)),
            }
        }
    }
    if specs.is_empty() {
        bail!("请用 --map 本地:远程 或 --from-file 指定要上传的文件");
    }

    let mut entries = Vec::new();
    let mut missing = Vec::new();
    for (local, remote) in specs {
        let lp = PathBuf::from(&local);
        if lp.is_dir() {
            let base_remote = match &remote {
                Some(r) => absolutize(r.trim_end_matches('/'), remote_root),
                None => join_root(remote_root, &local)?,
            };
            for f in walkdir::WalkDir::new(&lp)
                .into_iter()
                .filter_map(|e| e.ok())
                .filter(|e| e.file_type().is_file())
            {
                let rel = f.path().strip_prefix(&lp).unwrap();
                let remote = format!("{}/{}", base_remote, rel.to_string_lossy().replace('\\', "/"));
                let size = f.metadata().map(|m| m.len()).unwrap_or(0);
                entries.push(Entry {
                    local: f.path().to_path_buf(),
                    remote,
                    size,
                });
            }
        } else if lp.is_file() {
            let remote = match remote {
                Some(r) if r.ends_with('/') => format!(
                    "{}{}",
                    absolutize(&r, remote_root),
                    lp.file_name().unwrap().to_string_lossy()
                ),
                Some(r) => absolutize(&r, remote_root),
                None => join_root(remote_root, &local)?,
            };
            let size = lp.metadata().map(|m| m.len()).unwrap_or(0);
            entries.push(Entry { local: lp, remote, size });
        } else {
            missing.push(local);
        }
    }
    Ok((entries, missing))
}

/// 远程路径为相对路径时，拼接到主机配置的远程根目录下；绝对路径原样返回
fn absolutize(remote: &str, remote_root: Option<&str>) -> String {
    if remote.starts_with('/') {
        return remote.to_string();
    }
    match remote_root {
        Some(root) => format!("{}/{}", root.trim_end_matches('/'), remote),
        None => remote.to_string(),
    }
}

fn join_root(remote_root: Option<&str>, local: &str) -> Result<String> {
    let root = remote_root.context(
        "该路径未指定远程位置：请使用 本地:远程 格式，或提供 --remote-root（也可在主机配置 remote_root）",
    )?;
    let rel = local.trim_start_matches("./").trim_start_matches('/');
    Ok(format!("{}/{}", root.trim_end_matches('/'), rel))
}

pub fn upload_one(
    sftp: &Sftp,
    entry: &Entry,
    on_bytes: &mut dyn FnMut(u64),
    created_dirs: &mut HashSet<String>,
) -> Result<()> {
    // 远程路径若已是服务器上的目录，则改为上传到该目录下的同名文件，
    // 避免对目录调用 create 报 [SFTP(4)] failure
    let mut remote = entry.remote.clone();
    if let Ok(st) = sftp.stat(Path::new(&remote)) {
        if st.is_dir() {
            let name = entry
                .local
                .file_name()
                .context("本地路径缺少文件名")?
                .to_string_lossy();
            remote = format!("{}/{}", remote.trim_end_matches('/'), name);
        }
    }
    if let Some((parent, _)) = remote.rsplit_once('/') {
        ensure_dir(sftp, parent, created_dirs)?;
    }
    let mut src = fs::File::open(&entry.local)
        .with_context(|| format!("打开本地文件失败 {}", entry.local.display()))?;
    let mut dst = sftp
        .create(Path::new(&remote))
        .with_context(|| format!("创建远程文件失败 {remote}"))?;
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = src.read(&mut buf)?;
        if n == 0 {
            break;
        }
        dst.write_all(&buf[..n])
            .with_context(|| format!("写入远程文件失败 {remote}"))?;
        on_bytes(n as u64);
    }
    Ok(())
}

fn ensure_dir(sftp: &Sftp, dir: &str, created: &mut HashSet<String>) -> Result<()> {
    if dir.is_empty() || dir == "/" || created.contains(dir) {
        return Ok(());
    }
    if sftp.stat(Path::new(dir)).is_ok() {
        created.insert(dir.to_string());
        return Ok(());
    }
    if let Some((parent, _)) = dir.rsplit_once('/') {
        ensure_dir(sftp, parent, created)?;
    }
    let _ = sftp.mkdir(Path::new(dir), 0o755);
    created.insert(dir.to_string());
    Ok(())
}
