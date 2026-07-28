use anyhow::{Context, Result};
use rusqlite::Connection;
use serde::Serialize;

#[derive(Serialize, Clone)]
pub struct TaskRow {
    pub id: i64,
    pub host: String,
    pub started_at: String,
    pub duration_ms: i64,
    pub total: i64,
    pub ok: i64,
    pub failed: i64,
    pub skipped: i64,
}

#[derive(Serialize, Clone)]
pub struct FileRow {
    pub local: String,
    pub remote: String,
    pub size: i64,
    pub result: String,
    pub error: Option<String>,
    pub duration_ms: i64,
}

pub fn open() -> Result<Connection> {
    let c = Connection::open(crate::config::db_path()?)?;
    c.execute_batch(
        "CREATE TABLE IF NOT EXISTS tasks(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            host TEXT NOT NULL,
            started_at TEXT NOT NULL,
            duration_ms INTEGER DEFAULT 0,
            total INTEGER DEFAULT 0,
            ok INTEGER DEFAULT 0,
            failed INTEGER DEFAULT 0,
            skipped INTEGER DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS files(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id INTEGER NOT NULL,
            local TEXT NOT NULL,
            remote TEXT NOT NULL,
            size INTEGER DEFAULT 0,
            result TEXT NOT NULL,
            error TEXT,
            duration_ms INTEGER DEFAULT 0
        );",
    )?;
    Ok(c)
}

pub fn start_task(c: &Connection, host: &str, total: usize) -> Result<i64> {
    c.execute(
        "INSERT INTO tasks(host, started_at, total) VALUES(?1, ?2, ?3)",
        (
            host,
            chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
            total as i64,
        ),
    )?;
    Ok(c.last_insert_rowid())
}

#[allow(clippy::too_many_arguments)]
pub fn add_file(
    c: &Connection,
    task_id: i64,
    local: &str,
    remote: &str,
    size: u64,
    result: &str,
    error: Option<&str>,
    duration_ms: u128,
) -> Result<()> {
    c.execute(
        "INSERT INTO files(task_id, local, remote, size, result, error, duration_ms)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        (
            task_id,
            local,
            remote,
            size as i64,
            result,
            error,
            duration_ms as i64,
        ),
    )?;
    Ok(())
}

pub fn finish_task(
    c: &Connection,
    id: i64,
    ok: usize,
    failed: usize,
    skipped: usize,
    duration_ms: u128,
) -> Result<()> {
    c.execute(
        "UPDATE tasks SET ok=?1, failed=?2, skipped=?3, duration_ms=?4 WHERE id=?5",
        (
            ok as i64,
            failed as i64,
            skipped as i64,
            duration_ms as i64,
            id,
        ),
    )?;
    Ok(())
}

pub fn list_tasks(host: Option<&str>, failed_only: bool, limit: usize) -> Result<Vec<TaskRow>> {
    let c = open()?;
    let mut sql = String::from(
        "SELECT id, host, started_at, duration_ms, total, ok, failed, skipped FROM tasks WHERE 1=1",
    );
    if host.is_some() {
        sql.push_str(" AND host = ?1");
    }
    if failed_only {
        sql.push_str(" AND failed > 0");
    }
    sql.push_str(&format!(" ORDER BY id DESC LIMIT {limit}"));

    let mut stmt = c.prepare(&sql)?;
    let map = |row: &rusqlite::Row| -> rusqlite::Result<TaskRow> {
        Ok(TaskRow {
            id: row.get(0)?,
            host: row.get(1)?,
            started_at: row.get(2)?,
            duration_ms: row.get(3)?,
            total: row.get(4)?,
            ok: row.get(5)?,
            failed: row.get(6)?,
            skipped: row.get(7)?,
        })
    };
    let rows: Vec<TaskRow> = if let Some(h) = host {
        stmt.query_map([h], map)?.collect::<rusqlite::Result<_>>()?
    } else {
        stmt.query_map([], map)?.collect::<rusqlite::Result<_>>()?
    };
    Ok(rows)
}

pub fn task_detail(task_id: i64) -> Result<(TaskRow, Vec<FileRow>)> {
    let c = open()?;
    let task = c
        .query_row(
            "SELECT id, host, started_at, duration_ms, total, ok, failed, skipped FROM tasks WHERE id = ?1",
            [task_id],
            |r| {
                Ok(TaskRow {
                    id: r.get(0)?,
                    host: r.get(1)?,
                    started_at: r.get(2)?,
                    duration_ms: r.get(3)?,
                    total: r.get(4)?,
                    ok: r.get(5)?,
                    failed: r.get(6)?,
                    skipped: r.get(7)?,
                })
            },
        )
        .with_context(|| format!("任务 {task_id} 不存在"))?;
    let mut stmt = c.prepare(
        "SELECT local, remote, size, result, error, duration_ms FROM files WHERE task_id = ?1",
    )?;
    let files = stmt
        .query_map([task_id], |r| {
            Ok(FileRow {
                local: r.get(0)?,
                remote: r.get(1)?,
                size: r.get(2)?,
                result: r.get(3)?,
                error: r.get(4)?,
                duration_ms: r.get(5)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok((task, files))
}

pub fn print_list(host: Option<&str>, failed_only: bool, limit: usize) -> Result<()> {
    let rows = list_tasks(host, failed_only, limit)?;
    if rows.is_empty() {
        println!("暂无上传记录。");
        return Ok(());
    }
    println!(
        "{:<6} {:<12} {:<20} {:>8} {:>6} {:>6} {:>6} {:>6}",
        "ID", "主机", "时间", "耗时ms", "总数", "成功", "失败", "剔除"
    );
    for t in rows {
        let failed_col = format!("{:>6}", t.failed);
        let failed_col = if t.failed > 0 {
            format!("\x1b[31m{failed_col}\x1b[0m")
        } else {
            failed_col
        };
        println!(
            "{:<6} {:<12} {:<20} {:>8} {:>6} \x1b[32m{:>6}\x1b[0m {failed_col} {:>6}",
            t.id, t.host, t.started_at, t.duration_ms, t.total, t.ok, t.skipped
        );
    }
    println!("\n查看明细: sup log show <ID>");
    Ok(())
}

pub fn print_show(task_id: i64) -> Result<()> {
    let (task, files) = task_detail(task_id)?;
    println!(
        "任务 #{}  主机: {}  时间: {}\n",
        task.id, task.host, task.started_at
    );
    for f in files {
        let status = match f.result.as_str() {
            "ok" => "\x1b[32m成功\x1b[0m".to_string(),
            "failed" => format!("\x1b[31m失败\x1b[0m ({})", f.error.unwrap_or_default()),
            _ => "\x1b[33m剔除\x1b[0m".to_string(),
        };
        println!(
            "{status}  {} -> {}  {}B  {}ms",
            f.local, f.remote, f.size, f.duration_ms
        );
    }
    Ok(())
}
