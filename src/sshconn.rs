use crate::config::{self, HostConfig};
use anyhow::{bail, Context, Result};
use ssh2::Session;
use std::net::{TcpStream, ToSocketAddrs};
use std::path::Path;
use std::time::Duration;

#[derive(Clone)]
pub enum Cred {
    Password(String),
    Key {
        path: String,
        passphrase: Option<String>,
    },
}

pub fn resolve_cred(name: &str, cfg: &HostConfig) -> Result<Cred> {
    if let Some(key) = &cfg.key_path {
        Ok(Cred::Key {
            path: key.clone(),
            passphrase: config::get_secret(&format!("{name}#passphrase")),
        })
    } else {
        let pass = match config::get_secret(name) {
            Some(p) => p,
            None => {
                let p = rpassword::prompt_password(format!("{}@{} 密码: ", cfg.user, cfg.host))?;
                if !p.is_empty() {
                    let _ = config::set_secret(name, &p);
                }
                p
            }
        };
        Ok(Cred::Password(pass))
    }
}

pub fn resolve_cred_stored(name: &str, cfg: &HostConfig) -> Result<Cred> {
    if let Some(key) = &cfg.key_path {
        Ok(Cred::Key {
            path: key.clone(),
            passphrase: config::get_secret(&format!("{name}#passphrase")),
        })
    } else {
        let pass = config::get_secret(name)
            .with_context(|| format!("主机 `{name}` 未存储密码，请在主机管理中重新保存密码"))?;
        Ok(Cred::Password(pass))
    }
}

pub fn open_session(cfg: &HostConfig, cred: &Cred) -> Result<Session> {
    let addr = format!("{}:{}", cfg.host, cfg.port);
    let sock = addr
        .to_socket_addrs()
        .with_context(|| format!("地址解析失败: {addr}"))?
        .next()
        .context("地址解析失败")?;
    let tcp = TcpStream::connect_timeout(&sock, Duration::from_secs(10))
        .with_context(|| format!("无法连接 {addr}（超时或主机不可达）"))?;
    let mut sess = Session::new()?;
    sess.set_tcp_stream(tcp);
    sess.set_timeout(30_000);
    sess.handshake().context("SSH 握手失败")?;
    match cred {
        Cred::Password(p) => sess
            .userauth_password(&cfg.user, p)
            .context("认证失败：密码错误（可用 `sup host edit <name> --reset-secret` 重设）")?,
        Cred::Key { path, passphrase } => sess
            .userauth_pubkey_file(&cfg.user, None, Path::new(path), passphrase.as_deref())
            .context("认证失败：私钥无效或 passphrase 错误")?,
    }
    if !sess.authenticated() {
        bail!("认证失败");
    }
    Ok(sess)
}

pub fn connect(name: &str) -> Result<(HostConfig, Session, Cred)> {
    let cfg = config::get_host(name)?;
    let cred = resolve_cred(name, &cfg)?;
    let sess = open_session(&cfg, &cred)?;
    Ok((cfg, sess, cred))
}
