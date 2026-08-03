use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::broadcast;

/// 命令风险等级
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum RiskLevel {
    /// 只读操作，安全
    Safe,
    /// 写入但可逆
    Risky,
    /// 不可逆破坏性操作
    Dangerous,
}

/// 审批状态
#[derive(Debug, Clone, Serialize)]
pub struct ApprovalRequest {
    pub id: String,
    pub command: String,
    pub risk: RiskLevel,
    pub host: String,
    #[serde(skip)]
    pub created_at: Instant,
}

#[derive(Debug, Clone, Serialize)]
pub struct ApprovalResult {
    pub id: String,
    pub approved: bool,
    pub rejected_reason: Option<String>,
}

/// 审批状态管理器
struct ApprovalState {
    request: ApprovalRequest,
    result_tx: tokio::sync::oneshot::Sender<ApprovalResult>,
}

static APPROVALS: OnceLock<Mutex<HashMap<String, ApprovalState>>> = OnceLock::new();
const APPROVAL_TIMEOUT: Duration = Duration::from_secs(30);

fn approvals() -> &'static Mutex<HashMap<String, ApprovalState>> {
    APPROVALS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 命令风险分级
pub fn classify_risk(command: &str) -> RiskLevel {
    let cmd = command.trim();
    let base = cmd
        .split_whitespace()
        .next()
        .unwrap_or("")
        .split('/')
        .next_back()
        .unwrap_or("");

    // 危险命令：不可逆破坏性操作
    let dangerous_patterns: &[(&str, &str)] = &[
        ("rm", "-rf"),
        ("rm", "-r"),
        ("rmdir", ""),
        ("dd", ""),
        ("mkfs", ""),
        ("mkswap", ""),
        ("fdisk", ""),
        ("parted", ""),
    ];

    // 危险 command 名称
    let dangerous_commands: &[&str] = &[
        "shutdown",
        "reboot",
        "halt",
        "poweroff",
        "init",
        "iptables",
        "nft",
        "firewall-cmd",
        "ufw",
    ];

    // 检查危险命令
    for dc in dangerous_commands {
        if base == *dc {
            return RiskLevel::Dangerous;
        }
    }

    // 检查 rm 危险参数
    for (cmd_name, dangerous_flag) in dangerous_patterns {
        if base == *cmd_name && (!dangerous_flag.is_empty() && cmd.contains(dangerous_flag)) {
            return RiskLevel::Dangerous;
        }
    }
    // rm 不带 -rf 但仍然是危险的
    if base == "rm" {
        return RiskLevel::Dangerous;
    }

    // 检查 chmod 777 等危险权限
    if base == "chmod" {
        if cmd.contains("777") || cmd.contains("7777") || cmd.contains("-R") || cmd.contains("-r")
        {
            return RiskLevel::Dangerous;
        }
        return RiskLevel::Risky;
    }

    // 检查重定向覆盖 (command > file)
    if cmd.contains(">") && !cmd.contains(">>") {
        // cat /dev/null > file 这种是危险的
        if cmd.contains("/dev/null") || cmd.contains("echo") {
            return RiskLevel::Risky;
        }
        return RiskLevel::Dangerous;
    }

    // 危险组合：chown root:root 等
    if base == "chown" && (cmd.contains(":root") || cmd.contains("root:")) {
        return RiskLevel::Dangerous;
    }

    // 安全命令：只读操作
    let safe_commands: &[&str] = &[
        "ls", "cat", "head", "tail", "less", "more", "grep", "egrep", "fgrep",
        "find", "locate", "which", "whereis", "type", "file", "stat", "du", "df",
        "ps", "top", "htop", "free", "uptime", "uname", "hostname", "whoami",
        "id", "groups", "w", "who", "last", "history", "pwd", "echo", "printf",
        "date", "cal", "env", "printenv", "ulimit", "wc", "sort", "uniq", "cut",
        "tr", "diff", "cmp", "md5sum", "sha256sum", "sha1sum", "base64",
        "awk", "sed", "lsof", "netstat", "ss", "ip", "ifconfig", "route",
        "ping", "traceroute", "nslookup", "dig", "host", "curl", "wget",
        "systemctl", "service", "journalctl", "dmesg",
    ];

    for sc in safe_commands {
        if base == *sc {
            // systemctl 和 service 如果是 stop/restart 等则是 risky
            if (base == "systemctl" || base == "service")
                && (cmd.contains("stop")
                    || cmd.contains("restart")
                    || cmd.contains("disable")
                    || cmd.contains("mask"))
            {
                return RiskLevel::Risky;
            }
            // ip 命令有写入操作
            if base == "ip" && (cmd.contains("add") || cmd.contains("del") || cmd.contains("set"))
            {
                return RiskLevel::Risky;
            }
            return RiskLevel::Safe;
        }
    }

    // 写入但可逆的命令
    let risky_commands: &[&str] = &[
        "cp", "mv", "touch", "mkdir", "rmdir", "ln", "chmod", "chown", "chgrp",
        "tar", "gzip", "gunzip", "zip", "unzip", "tee", "scp", "rsync",
        "kill", "killall", "pkill", "crontab", "mount", "umount",
    ];

    for rc in risky_commands {
        if base == *rc {
            return RiskLevel::Risky;
        }
    }

    // 默认：未知命令视为危险
    RiskLevel::Dangerous
}

/// 审批事件（用于 SSE 推送）
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type")]
pub enum ApprovalEvent {
    #[serde(rename = "new")]
    New(ApprovalRequest),
    #[serde(rename = "approved")]
    Approved { id: String },
    #[serde(rename = "rejected")]
    Rejected { id: String, reason: Option<String> },
}

/// 广播通道（容量 16，避免慢消费者阻塞）
static EVENT_TX: OnceLock<broadcast::Sender<ApprovalEvent>> = OnceLock::new();

fn event_tx() -> &'static broadcast::Sender<ApprovalEvent> {
    EVENT_TX.get_or_init(|| broadcast::channel(16).0)
}

/// 订阅审批事件流
pub fn subscribe_events() -> broadcast::Receiver<ApprovalEvent> {
    event_tx().subscribe()
}

/// 提交审批请求，返回 oneshot receiver 等待审批结果
pub fn submit_approval(
    host: &str,
    command: &str,
) -> (
    String,
    tokio::sync::oneshot::Receiver<ApprovalResult>,
) {
    let id = format!("apr-{}", uuid_v4());
    let (tx, rx) = tokio::sync::oneshot::channel();
    let request = ApprovalRequest {
        id: id.clone(),
        command: command.to_string(),
        risk: classify_risk(command),
        host: host.to_string(),
        created_at: Instant::now(),
    };

    approvals().lock().unwrap().insert(
        id.clone(),
        ApprovalState {
            request: request.clone(),
            result_tx: tx,
        },
    );

    // 广播新审批事件
    let _ = event_tx().send(ApprovalEvent::New(request));

    (id, rx)
}

/// 获取所有待审批的请求（同时清理超时并广播拒绝事件）
pub fn pending_approvals() -> Vec<ApprovalRequest> {
    let now = Instant::now();
    let mut lock = approvals().lock().unwrap();
    // 清理超时的：收集超时的 key
    let timeout_keys: Vec<String> = lock
        .iter()
        .filter(|(_, state)| now.duration_since(state.request.created_at) > APPROVAL_TIMEOUT)
        .map(|(k, _)| k.clone())
        .collect();
    for k in timeout_keys {
        if let Some(state) = lock.remove(&k) {
            let id = k.clone();
            let _ = state.result_tx.send(ApprovalResult {
                id: id.clone(),
                approved: false,
                rejected_reason: Some("审批超时自动拒绝".to_string()),
            });
            let _ = event_tx().send(ApprovalEvent::Rejected {
                id,
                reason: Some("审批超时自动拒绝".to_string()),
            });
        }
    }
    lock.values()
        .map(|s| s.request.clone())
        .collect()
}

/// 审批通过
pub fn approve(id: &str) -> bool {
    if let Some(state) = approvals().lock().unwrap().remove(id) {
        let _ = state.result_tx.send(ApprovalResult {
            id: id.to_string(),
            approved: true,
            rejected_reason: None,
        });
        let _ = event_tx().send(ApprovalEvent::Approved { id: id.to_string() });
        true
    } else {
        false
    }
}

/// 审批拒绝
pub fn reject(id: &str, reason: Option<String>) -> bool {
    if let Some(state) = approvals().lock().unwrap().remove(id) {
        let _ = state.result_tx.send(ApprovalResult {
            id: id.to_string(),
            approved: false,
            rejected_reason: reason.clone(),
        });
        let _ = event_tx().send(ApprovalEvent::Rejected { id: id.to_string(), reason });
        true
    } else {
        false
    }
}

/// 生成简易 UUID v4
fn uuid_v4() -> String {
    let t = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let r = (t % 1_000_000_000) as u32;
    format!(
        "{:08x}-{:04x}-4{:03x}-{:04x}-{:012x}",
        r.wrapping_mul(1103515245).wrapping_add(12345),
        (r >> 16) & 0xFFFF,
        r & 0xFFF,
        0x8000u32 | (r & 0x3FFF),
        (t as u64) & 0xFFFF_FFFF_FFFF
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_safe_commands() {
        assert_eq!(classify_risk("ls -la"), RiskLevel::Safe);
        assert_eq!(classify_risk("cat /etc/hosts"), RiskLevel::Safe);
        assert_eq!(classify_risk("df -h"), RiskLevel::Safe);
        assert_eq!(classify_risk("ps aux"), RiskLevel::Safe);
        assert_eq!(classify_risk("top -n 1"), RiskLevel::Safe);
        assert_eq!(classify_risk("grep error /var/log/syslog"), RiskLevel::Safe);
        assert_eq!(classify_risk("find /var/log -name '*.log'"), RiskLevel::Safe);
        assert_eq!(classify_risk("systemctl status nginx"), RiskLevel::Safe);
    }

    #[test]
    fn test_risky_commands() {
        assert_eq!(classify_risk("cp /tmp/a /etc/b"), RiskLevel::Risky);
        assert_eq!(classify_risk("mv file /tmp/"), RiskLevel::Risky);
        assert_eq!(classify_risk("touch /etc/new.conf"), RiskLevel::Risky);
        assert_eq!(classify_risk("systemctl restart nginx"), RiskLevel::Risky);
        assert_eq!(classify_risk("kill 1234"), RiskLevel::Risky);
        assert_eq!(classify_risk("chmod 644 file"), RiskLevel::Risky);
    }

    #[test]
    fn test_dangerous_commands() {
        assert_eq!(classify_risk("rm -rf /tmp/test"), RiskLevel::Dangerous);
        assert_eq!(classify_risk("rm file.txt"), RiskLevel::Dangerous);
        assert_eq!(classify_risk("chmod 777 /var/www"), RiskLevel::Dangerous);
        assert_eq!(classify_risk("shutdown -h now"), RiskLevel::Dangerous);
        assert_eq!(classify_risk("reboot"), RiskLevel::Dangerous);
        assert_eq!(classify_risk("dd if=/dev/zero of=/dev/sda"), RiskLevel::Dangerous);
        assert_eq!(classify_risk("iptables -F"), RiskLevel::Dangerous);
    }
}
