mod aiservice;
mod approval;
mod config;
mod fileops;
mod logdb;
mod push;
mod repl;
mod sshconn;
mod terminal;
mod ui;

use anyhow::{bail, Result};
use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(name = "sup", version, about = "轻量级远程部署与主机管理工具")]
struct Cli {
    /// 不带子命令时进入交互式 REPL
    #[command(subcommand)]
    command: Option<Commands>,
}

#[derive(Subcommand)]
enum Commands {
    /// 主机配置管理
    Host {
        #[command(subcommand)]
        action: HostAction,
    },
    /// 上传文件到远程主机（校验 -> 剔除 -> 并发上传 -> 日志）
    Push {
        /// 主机名称
        host: String,
        /// 路径映射，格式 本地:远程，可重复
        #[arg(long = "map", value_name = "LOCAL:REMOTE")]
        maps: Vec<String>,
        /// 从文件读取路径列表（每行：本地路径 或 本地:远程）
        #[arg(long, value_name = "FILE")]
        from_file: Option<String>,
        /// 远程根目录（配合 from-file 中的相对路径）
        #[arg(long, value_name = "DIR")]
        remote_root: Option<String>,
        /// 缺失文件自动剔除，不再询问
        #[arg(short, long)]
        yes: bool,
        /// 并发数
        #[arg(long, default_value_t = 4)]
        concurrency: usize,
        /// 单文件失败重试次数
        #[arg(long, default_value_t = 2)]
        retry: u32,
    },
    /// 打开交互式远程终端
    Ssh {
        /// 主机名称
        host: String,
    },
    /// 上传日志
    Log {
        #[command(subcommand)]
        action: LogAction,
    },
    /// 启动 Web 界面
    Ui {
        #[arg(long, default_value_t = 7788)]
        port: u16,
    },
}

#[derive(Subcommand)]
enum HostAction {
    /// 新增主机
    Add {
        name: String,
        #[arg(long)]
        host: String,
        #[arg(long, default_value_t = 22)]
        port: u16,
        #[arg(long)]
        user: String,
        /// 私钥路径（不填则使用密码认证）
        #[arg(long)]
        key: Option<String>,
        /// 默认远程根目录
        #[arg(long)]
        remote_root: Option<String>,
        #[arg(long)]
        note: Option<String>,
    },
    /// 列出主机
    List,
    /// 修改主机（仅更新给出的字段）
    Edit {
        name: String,
        #[arg(long)]
        host: Option<String>,
        #[arg(long)]
        port: Option<u16>,
        #[arg(long)]
        user: Option<String>,
        #[arg(long)]
        key: Option<String>,
        #[arg(long)]
        remote_root: Option<String>,
        #[arg(long)]
        note: Option<String>,
        /// 重新录入密码/passphrase
        #[arg(long)]
        reset_secret: bool,
    },
    /// 删除主机
    Rm { name: String },
    /// 测试连通性
    Test { name: String },
}

#[derive(Subcommand)]
enum LogAction {
    /// 最近上传任务列表
    List {
        #[arg(long)]
        host: Option<String>,
        /// 只看含失败的任务
        #[arg(long)]
        failed: bool,
        #[arg(long, default_value_t = 20)]
        limit: usize,
    },
    /// 查看某次任务的文件明细
    Show { task_id: i64 },
}

fn main() {
    if let Err(e) = run() {
        eprintln!("\x1b[31m错误: {e:#}\x1b[0m");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let command = match Cli::parse().command {
        Some(c) => c,
        None => return repl::run(),
    };
    match command {
        Commands::Host { action } => host_cmd(action),
        Commands::Push {
            host,
            maps,
            from_file,
            remote_root,
            yes,
            concurrency,
            retry,
        } => push::run(
            &host,
            &maps,
            from_file.as_deref(),
            remote_root.as_deref(),
            push::Options {
                yes,
                concurrency: concurrency.max(1),
                retry,
            },
        ),
        Commands::Ssh { host } => {
            let (_, sess, _) = sshconn::connect(&host)?;
            println!("已连接 {host}，退出 shell 返回本地。");
            terminal::shell(&sess)
        }
        Commands::Log { action } => match action {
            LogAction::List {
                host,
                failed,
                limit,
            } => logdb::print_list(host.as_deref(), failed, limit),
            LogAction::Show { task_id } => logdb::print_show(task_id),
        },
        Commands::Ui { port } => ui::run(port),
    }
}

fn host_cmd(action: HostAction) -> Result<()> {
    match action {
        HostAction::Add {
            name,
            host,
            port,
            user,
            key,
            remote_root,
            note,
        } => {
            let mut hosts = config::load_hosts()?;
            if hosts.contains_key(&name) {
                bail!("主机 `{name}` 已存在，可用 `sup host edit {name}` 修改");
            }
            let use_password = key.is_none();
            hosts.insert(
                name.clone(),
                config::HostConfig {
                    host,
                    port,
                    user,
                    key_path: key.clone(),
                    remote_root,
                    note,
                },
            );
            config::save_hosts(&hosts)?;
            if use_password {
                match rpassword::prompt_password("登录密码（存入系统钥匙串，回车跳过）: ") {
                    Ok(p) if !p.is_empty() => config::set_secret(&name, &p)?,
                    Ok(_) => {}
                    Err(_) => println!("(无法读取输入，跳过密码录入，首次连接时会再询问)"),
                }
            } else {
                match rpassword::prompt_password("私钥 passphrase（无则直接回车）: ") {
                    Ok(p) if !p.is_empty() => {
                        config::set_secret(&format!("{name}#passphrase"), &p)?
                    }
                    Ok(_) => {}
                    Err(_) => println!("(无法读取输入，跳过 passphrase 录入)"),
                }
            }
            println!("已添加主机 `{name}`。可运行 `sup host test {name}` 验证连接。");
            Ok(())
        }
        HostAction::List => {
            let hosts = config::load_hosts()?;
            if hosts.is_empty() {
                println!("暂无主机，使用 `sup host add <name> --host <ip> --user <user>` 添加。");
                return Ok(());
            }
            println!("{:<14} {:<22} {:<8} {:<10} 备注", "名称", "地址", "认证", "远程根目录");
            for (name, c) in hosts {
                let auth = if c.key_path.is_some() { "私钥" } else { "密码" };
                println!(
                    "{:<14} {:<22} {:<8} {:<10} {}",
                    name,
                    format!("{}@{}:{}", c.user, c.host, c.port),
                    auth,
                    c.remote_root.as_deref().unwrap_or("-"),
                    c.note.as_deref().unwrap_or("")
                );
            }
            Ok(())
        }
        HostAction::Edit {
            name,
            host,
            port,
            user,
            key,
            remote_root,
            note,
            reset_secret,
        } => {
            let mut hosts = config::load_hosts()?;
            let c = hosts
                .get_mut(&name)
                .ok_or_else(|| anyhow::anyhow!("主机 `{name}` 不存在"))?;
            if let Some(v) = host {
                c.host = v;
            }
            if let Some(v) = port {
                c.port = v;
            }
            if let Some(v) = user {
                c.user = v;
            }
            if let Some(v) = key {
                c.key_path = Some(v);
            }
            if let Some(v) = remote_root {
                c.remote_root = Some(v);
            }
            if let Some(v) = note {
                c.note = Some(v);
            }
            let use_password = c.key_path.is_none();
            config::save_hosts(&hosts)?;
            if reset_secret {
                if use_password {
                    let p = rpassword::prompt_password("新密码: ")?;
                    config::set_secret(&name, &p)?;
                } else {
                    let p = rpassword::prompt_password("新 passphrase: ")?;
                    config::set_secret(&format!("{name}#passphrase"), &p)?;
                }
            }
            println!("已更新主机 `{name}`。");
            Ok(())
        }
        HostAction::Rm { name } => {
            let mut hosts = config::load_hosts()?;
            if hosts.remove(&name).is_none() {
                bail!("主机 `{name}` 不存在");
            }
            config::save_hosts(&hosts)?;
            config::delete_secret(&name);
            config::delete_secret(&format!("{name}#passphrase"));
            println!("已删除主机 `{name}`。");
            Ok(())
        }
        HostAction::Test { name } => {
            let (cfg, _sess, _) = sshconn::connect(&name)?;
            println!(
                "\x1b[32m连接成功\x1b[0m {}@{}:{}",
                cfg.user, cfg.host, cfg.port
            );
            Ok(())
        }
    }
}
