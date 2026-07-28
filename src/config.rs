use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

pub const KEYRING_SERVICE: &str = "sup-cli";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostConfig {
    pub host: String,
    #[serde(default = "default_port")]
    pub port: u16,
    pub user: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_root: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

fn default_port() -> u16 {
    22
}

pub fn config_dir() -> Result<PathBuf> {
    let d = dirs::config_dir().context("无法定位系统配置目录")?.join("sup");
    fs::create_dir_all(&d)?;
    Ok(d)
}

pub fn hosts_path() -> Result<PathBuf> {
    Ok(config_dir()?.join("hosts.toml"))
}

pub fn db_path() -> Result<PathBuf> {
    Ok(config_dir()?.join("sup.db"))
}

pub fn load_hosts() -> Result<BTreeMap<String, HostConfig>> {
    let p = hosts_path()?;
    if !p.exists() {
        return Ok(BTreeMap::new());
    }
    let s = fs::read_to_string(&p)?;
    toml::from_str(&s).context("hosts.toml 解析失败")
}

pub fn save_hosts(hosts: &BTreeMap<String, HostConfig>) -> Result<()> {
    fs::write(hosts_path()?, toml::to_string_pretty(hosts)?)?;
    Ok(())
}

pub fn get_host(name: &str) -> Result<HostConfig> {
    load_hosts()?
        .remove(name)
        .with_context(|| format!("主机 `{name}` 不存在，用 `sup host list` 查看"))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PresetMap {
    pub local: String,
    #[serde(default)]
    pub remote: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Preset {
    pub host: String,
    #[serde(default)]
    pub maps: Vec<PresetMap>,
}

pub fn presets_path() -> Result<PathBuf> {
    Ok(config_dir()?.join("presets.toml"))
}

pub fn load_presets() -> Result<BTreeMap<String, Preset>> {
    let p = presets_path()?;
    if !p.exists() {
        return Ok(BTreeMap::new());
    }
    let s = fs::read_to_string(&p)?;
    toml::from_str(&s).context("presets.toml 解析失败")
}

pub fn save_presets(presets: &BTreeMap<String, Preset>) -> Result<()> {
    fs::write(presets_path()?, toml::to_string_pretty(presets)?)?;
    Ok(())
}

pub fn set_secret(name: &str, secret: &str) -> Result<()> {
    keyring::Entry::new(KEYRING_SERVICE, name)?.set_password(secret)?;
    Ok(())
}

pub fn get_secret(name: &str) -> Option<String> {
    keyring::Entry::new(KEYRING_SERVICE, name).ok()?.get_password().ok()
}

pub fn delete_secret(name: &str) {
    if let Ok(e) = keyring::Entry::new(KEYRING_SERVICE, name) {
        let _ = e.delete_password();
    }
}
