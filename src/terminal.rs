use anyhow::Result;
use crossterm::terminal;
use ssh2::{Channel, Session};
use std::io::{Read, Write};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

pub fn shell(sess: &Session) -> Result<()> {
    let (cols, rows) = terminal::size().unwrap_or((80, 24));
    let mut ch = sess.channel_session()?;
    ch.request_pty("xterm-256color", None, Some((cols as u32, rows as u32, 0, 0)))?;
    ch.shell()?;
    sess.set_blocking(false);
    terminal::enable_raw_mode()?;
    let result = pump(sess, &mut ch, (cols, rows));
    terminal::disable_raw_mode()?;
    sess.set_blocking(true);
    let _ = ch.close();
    let _ = ch.wait_close();
    println!();
    result
}

fn pump(sess: &Session, ch: &mut Channel, mut last_size: (u16, u16)) -> Result<()> {
    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    thread::spawn(move || {
        let mut stdin = std::io::stdin();
        let mut buf = [0u8; 1024];
        loop {
            match stdin.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if tx.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
    });

    let mut out = std::io::stdout();
    let mut rbuf = [0u8; 8192];
    loop {
        let mut active = false;
        match ch.read(&mut rbuf) {
            Ok(0) => {
                if ch.eof() {
                    return Ok(());
                }
            }
            Ok(n) => {
                out.write_all(&rbuf[..n])?;
                out.flush()?;
                active = true;
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
            Err(e) => return Err(e.into()),
        }
        match rx.try_recv() {
            Ok(data) => {
                write_full(sess, ch, &data)?;
                active = true;
            }
            Err(mpsc::TryRecvError::Empty) => {}
            Err(mpsc::TryRecvError::Disconnected) => return Ok(()),
        }
        if ch.eof() {
            return Ok(());
        }
        if let Ok(sz) = terminal::size() {
            if sz != last_size {
                last_size = sz;
                let _ = ch.request_pty_size(sz.0 as u32, sz.1 as u32, None, None);
            }
        }
        if !active {
            thread::sleep(Duration::from_millis(8));
        }
    }
}

fn write_full(_sess: &Session, ch: &mut Channel, mut data: &[u8]) -> Result<()> {
    while !data.is_empty() {
        match ch.write(data) {
            Ok(n) => data = &data[n..],
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(2));
            }
            Err(e) => return Err(e.into()),
        }
    }
    Ok(())
}
