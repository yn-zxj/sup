use crate::config::{self, HostConfig};
use crate::logdb;
use crate::push;
use crate::sshconn::{self, Cred};
use crate::terminal;
use anyhow::Result;
use ssh2::Session;
use std::io::{Read, Write};

struct State {
    name: Option<String>,
    conn: Option<(HostConfig, Session, Cred)>,
}

pub fn run() -> Result<()> {
    println!("sup v{} — 输入 /help 查看命令，/quit 退出", env!("CARGO_PKG_VERSION"));
    let mut st = State { name: None, conn: None };
    loop {
        let prompt = match &st.name {
            Some(n) => format!("sup(\x1b[36m{n}\x1b[0m)> "),
            None => "sup> ".to_string(),
        };
        print!("{prompt}");
        std::io::stdout().flush()?;
        let mut line = String::new();
        if std::io::stdin().read_line(&mut line)? == 0 {
            break; // EOF
        }
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let (cmd, arg) = match line.split_once(char::is_whitespace) {
            Some((c, a)) => (c, a.trim()),
            None => (line, ""),
        };
        let r = match cmd {
            "/help" => {
                help();
                Ok(())
            }
            "/hosts" => hosts(),
            "/use" => use_host(&mut st, arg),
            "/push" => push_wizard(&mut st),
            "/log" => logdb::print_list(None, false, 10),
            "/ssh" => match ensure_conn(&mut st) {
                Ok(sess) => terminal::shell(sess),
                Err(e) => Err(e),
            },
            "/config" => {
                println!("配置文件: {}", config::hosts_path()?.display());
                println!("日志数据库: {}", config::db_path()?.display());
                Ok(())
            }
            "/ui" => crate::ui::run(7788),
            "/clear" => {
                print!("\x1b[2J\x1b[H");
                std::io::stdout().flush()?;
                Ok(())
            }
            "/quit" | "/exit" => break,
            c if c.starts_with('/') => {
                println!("未知命令 {c}，输入 /help 查看");
                Ok(())
            }
            _ => remote_exec(&mut st, line),
        };
        if let Err(e) = r {
            eprintln!("\x1b[31m错误: {e:#}\x1b[0m");
        }
    }
    Ok(())
}

fn help() {
    println!(
        "\
/help            显示帮助
/hosts           列出主机
/use <host>      切换当前主机（并建立连接）
/push            上传向导（当前主机）
/log             最近上传日志
/ssh             打开当前主机交互式终端
/config          查看配置文件位置
/ui              Web 界面（M2）
/clear           清屏
/quit            退出
其他输入          在当前主机上作为远程命令执行"
    );
}

fn hosts() -> Result<()> {
    let hosts = config::load_hosts()?;
    if hosts.is_empty() {
        println!("暂无主机，先用 `sup host add` 添加。");
        return Ok(());
    }
    for (name, c) in hosts {
        println!("  {name:<14} {}@{}:{}", c.user, c.host, c.port);
    }
    println!("使用 /use <host> 切换");
    Ok(())
}

fn use_host(st: &mut State, name: &str) -> Result<()> {
    if name.is_empty() {
        println!("用法: /use <host>");
        return Ok(());
    }
    let (cfg, sess, cred) = sshconn::connect(name)?;
    println!("\x1b[32m已连接\x1b[0m {}@{}:{}", cfg.user, cfg.host, cfg.port);
    st.name = Some(name.to_string());
    st.conn = Some((cfg, sess, cred));
    Ok(())
}

fn ensure_conn(st: &mut State) -> Result<&Session> {
    if st.conn.is_none() {
        anyhow::bail!("尚未选择主机，先执行 /use <host>");
    }
    Ok(&st.conn.as_ref().unwrap().1)
}

fn push_wizard(st: &mut State) -> Result<()> {
    let name = match &st.name {
        Some(n) => n.clone(),
        None => anyhow::bail!("尚未选择主机，先执行 /use <host>"),
    };
    println!("输入路径映射（本地:远程，每行一条，空行结束）:");
    let mut maps = Vec::new();
    loop {
        print!("  > ");
        std::io::stdout().flush()?;
        let mut line = String::new();
        std::io::stdin().read_line(&mut line)?;
        let line = line.trim();
        if line.is_empty() {
            break;
        }
        maps.push(line.to_string());
    }
    if maps.is_empty() {
        println!("未输入任何映射，已取消。");
        return Ok(());
    }
    push::run(
        &name,
        &maps,
        None,
        None,
        push::Options {
            yes: false,
            concurrency: 4,
            retry: 2,
        },
    )
}

fn remote_exec(st: &mut State, cmd: &str) -> Result<()> {
    let sess = match &st.conn {
        Some((_, s, _)) => s,
        None => anyhow::bail!("尚未选择主机（/use <host>），或输入 / 开头的命令"),
    };
    let mut ch = sess.channel_session()?;
    ch.exec(cmd)?;
    let mut out = String::new();
    ch.read_to_string(&mut out)?;
    print!("{out}");
    let mut err = String::new();
    ch.stderr().read_to_string(&mut err)?;
    if !err.is_empty() {
        eprint!("\x1b[31m{err}\x1b[0m");
    }
    ch.wait_close()?;
    let code = ch.exit_status()?;
    if code != 0 {
        println!("\x1b[33m[exit {code}]\x1b[0m");
    }
    Ok(())
}
