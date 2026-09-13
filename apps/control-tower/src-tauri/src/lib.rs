use std::{
  collections::HashMap,
  env, fs,
  io::Read,
  path::{Path, PathBuf},
  process::{Command, Stdio},
  sync::mpsc,
  thread,
  time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde::Serialize;
use serde_json::Value;
use tauri::{
  menu::{Menu, MenuItem, PredefinedMenuItem},
  tray::TrayIconBuilder,
  Manager,
};

const RECLAIM_UNAVAILABLE: &str = "安全回收分類器尚不可用；未推定可刪除。";
const COMMAND_TIMEOUT: Duration = Duration::from_secs(5);
const COMMAND_POLL_INTERVAL: Duration = Duration::from_millis(20);
const TRAY_REFRESH_INTERVAL: Duration = Duration::from_secs(15);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PullRequestView {
  number: u64,
  state: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentView {
  provider: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  profile: Option<String>,
  state: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  duration_ms: Option<u64>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorktreeView {
  path: String,
  short_id: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  branch: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  head_sha: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  clean: Option<bool>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProcessView {
  pid: u32,
  #[serde(skip_serializing_if = "Option::is_none")]
  rss_bytes: Option<u64>,
  state: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReclaimView {
  state: String,
  reason: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkUnitView {
  repository: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  issue: Option<u64>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pull_request: Option<PullRequestView>,
  #[serde(skip_serializing_if = "Option::is_none")]
  run_id: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  agent: Option<AgentView>,
  worktree: WorktreeView,
  #[serde(skip_serializing_if = "Option::is_none")]
  process: Option<ProcessView>,
  #[serde(skip_serializing_if = "Option::is_none")]
  disk_bytes: Option<u64>,
  reclaim: ReclaimView,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SystemView {
  #[serde(skip_serializing_if = "Option::is_none")]
  memory_total_bytes: Option<u64>,
  #[serde(skip_serializing_if = "Option::is_none")]
  memory_used_bytes: Option<u64>,
  #[serde(skip_serializing_if = "Option::is_none")]
  data_total_bytes: Option<u64>,
  #[serde(skip_serializing_if = "Option::is_none")]
  data_free_bytes: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ControlTowerSnapshot {
  mode: &'static str,
  generated_at: String,
  rows: Vec<WorkUnitView>,
  system: SystemView,
  source_note: String,
}

#[derive(Default)]
struct ParsedWorktree {
  path: String,
  head_sha: Option<String>,
  branch: Option<String>,
}

#[derive(Default)]
struct RunObservation {
  id: String,
  repository: String,
  issue: Option<u64>,
  pull_request_number: Option<u64>,
  provider: Option<String>,
  state: String,
  duration_ms: Option<u64>,
}

trait CommandBoundary {
  fn run(&self, program: &str, args: &[&str]) -> Option<String>;
}

struct SystemCommands;

impl CommandBoundary for SystemCommands {
  fn run(&self, program: &str, args: &[&str]) -> Option<String> {
    output_with_timeout(program, args, COMMAND_TIMEOUT)
  }
}

fn output_with_timeout(program: &str, args: &[&str], timeout: Duration) -> Option<String> {
  let mut command = Command::new(program);
  command
    .args(args)
    .stdout(Stdio::piped())
    .stderr(Stdio::null());
  #[cfg(unix)]
  {
    use std::os::unix::process::CommandExt;
    // Isolate a command and any helpers it starts, so one timeout can close
    // inherited stdout handles without waiting for descendants to exit.
    command.process_group(0);
  }
  let mut child = command.spawn().ok()?;
  // Drain concurrently: a verbose command must not block on its stdout pipe
  // before `try_wait` can observe its exit or timeout.
  let mut stdout = child.stdout.take()?;
  let (sender, receiver) = mpsc::sync_channel(1);
  let reader = thread::spawn(move || {
    let mut bytes = Vec::new();
    let result = stdout
      .read_to_end(&mut bytes)
      .ok()
      .and_then(|_| String::from_utf8(bytes).ok());
    let _ = sender.send(result);
  });
  let started = Instant::now();
  loop {
    let status = match child.try_wait() {
      Ok(status) => status,
      Err(_) => {
        terminate_process_group(&mut child);
        let _ = child.wait();
        drop(reader);
        return None;
      }
    };
    match status {
      Some(status) if status.success() => {
        let remaining = timeout
          .checked_sub(started.elapsed())
          .unwrap_or(Duration::ZERO);
        return match receiver.recv_timeout(remaining) {
          Ok(output) => output,
          Err(_) => {
            terminate_process_group(&mut child);
            None
          }
        };
      }
      Some(_) => {
        terminate_process_group(&mut child);
        drop(reader);
        return None;
      }
      None if started.elapsed() >= timeout => {
        terminate_process_group(&mut child);
        let _ = child.wait();
        // Do not join: a hostile descendant could still hold stdout open.
        // The isolated process group has been terminated and this collector
        // must return its unavailable result within the declared deadline.
        drop(reader);
        return None;
      }
      None => thread::sleep(COMMAND_POLL_INTERVAL),
    }
  }
}

fn terminate_process_group(child: &mut std::process::Child) {
  #[cfg(unix)]
  unsafe {
    // `process_group(0)` made the direct child the group leader. A negative
    // PID signals every helper that inherited its stdout pipe.
    let _ = libc::kill(-(child.id() as i32), libc::SIGKILL);
  }
  #[cfg(not(unix))]
  {
    let _ = child.kill();
  }
}

fn repository_root(commands: &dyn CommandBoundary) -> Option<PathBuf> {
  let candidate = env::var_os("TACHIKO_CONTROL_TOWER_REPOSITORY")
    .map(PathBuf::from)
    .or_else(|| env::current_dir().ok())?;
  commands
    .run(
      "git",
      &[
        "-C",
        candidate.to_string_lossy().as_ref(),
        "rev-parse",
        "--show-toplevel",
      ],
    )
    .map(|root| PathBuf::from(root.trim()))
}

fn parse_worktrees(porcelain: &str) -> Vec<ParsedWorktree> {
  porcelain
    .split("\n\n")
    .filter_map(|block| {
      let mut entry = ParsedWorktree::default();
      for line in block.lines() {
        if let Some(value) = line.strip_prefix("worktree ") {
          entry.path = value.to_owned();
        }
        if let Some(value) = line.strip_prefix("HEAD ") {
          entry.head_sha = Some(value.to_owned());
        }
        if let Some(value) = line.strip_prefix("branch ") {
          entry.branch = Some(value.trim_start_matches("refs/heads/").to_owned());
        }
      }
      (!entry.path.is_empty()).then_some(entry)
    })
    .collect()
}

fn is_clean(commands: &dyn CommandBoundary, path: &str) -> Option<bool> {
  commands
    .run("git", &["-C", path, "status", "--porcelain"])
    .map(|status| status.trim().is_empty())
}

fn directory_bytes(commands: &dyn CommandBoundary, path: &str) -> Option<u64> {
  commands.run("du", &["-sk", path]).and_then(|result| {
    result
      .split_whitespace()
      .next()?
      .parse::<u64>()
      .ok()
      .map(|kilobytes| kilobytes * 1024)
  })
}

fn current_process(commands: &dyn CommandBoundary, path: &str) -> Option<ProcessView> {
  // Exact-path lsof is deliberately narrow: absence is not treated as proof of idleness.
  let pids = commands.run("lsof", &["-t", "--", path])?;
  let pid = pids
    .lines()
    .find_map(|line| line.trim().parse::<u32>().ok())?;
  let rss_bytes = commands
    .run("ps", &["-o", "rss=", "-p", &pid.to_string()])
    .and_then(|rss| rss.trim().parse::<u64>().ok())
    .map(|kilobytes| kilobytes * 1024);
  Some(ProcessView {
    pid,
    rss_bytes,
    state: "observed".to_owned(),
  })
}

fn github_repository(commands: &dyn CommandBoundary, root: &Path) -> Option<String> {
  let root_text = root.to_string_lossy();
  let remote = commands.run(
    "git",
    &[
      "-C",
      root_text.as_ref(),
      "config",
      "--get",
      "remote.origin.url",
    ],
  )?;
  let remote = remote.trim().trim_end_matches(".git");
  remote
    .strip_prefix("git@github.com:")
    .or_else(|| remote.strip_prefix("https://github.com/"))
    .filter(|value| value.split('/').count() == 2)
    .map(str::to_owned)
}

fn pull_request(
  commands: &dyn CommandBoundary,
  repository: &str,
  number: Option<u64>,
) -> Option<PullRequestView> {
  let number = number?;
  let json = commands.run(
    "gh",
    &[
      "pr",
      "view",
      &number.to_string(),
      "--repo",
      repository,
      "--json",
      "number,state",
    ],
  )?;
  let item: Value = serde_json::from_str(&json).ok()?;
  Some(PullRequestView {
    number: item.get("number")?.as_u64()?,
    state: item.get("state")?.as_str()?.to_owned(),
  })
}

fn run_directory() -> Option<PathBuf> {
  env::var_os("TACHIKO_DATA_DIR")
    .map(PathBuf::from)
    .or_else(|| env::var_os("HOME").map(|home| PathBuf::from(home).join(".tachiko-conductor/runs")))
}

fn string_at(value: &Value, path: &[&str]) -> Option<String> {
  let mut cursor = value;
  for key in path {
    cursor = cursor.get(*key)?;
  }
  cursor.as_str().map(str::to_owned)
}

fn number_at(value: &Value, path: &[&str]) -> Option<u64> {
  let mut cursor = value;
  for key in path {
    cursor = cursor.get(*key)?;
  }
  cursor.as_u64()
}

fn load_runs() -> HashMap<String, RunObservation> {
  let mut runs = HashMap::new();
  let Some(directory) = run_directory() else {
    return runs;
  };
  let Ok(entries) = fs::read_dir(directory) else {
    return runs;
  };
  for entry in entries.flatten() {
    if entry
      .path()
      .extension()
      .and_then(|extension| extension.to_str())
      != Some("json")
    {
      continue;
    }
    let Ok(raw) = fs::read_to_string(entry.path()) else {
      continue;
    };
    let Ok(value) = serde_json::from_str::<Value>(&raw) else {
      continue;
    };
    let Some(workspace_path) = string_at(&value, &["bootstrap", "workspacePath"]) else {
      continue;
    };
    let observation = RunObservation {
      id: string_at(&value, &["id"]).unwrap_or_default(),
      repository: string_at(&value, &["target", "repo"]).unwrap_or_else(|| "unknown".to_owned()),
      issue: number_at(&value, &["target", "issueNumber"]),
      pull_request_number: number_at(&value, &["pullRequest", "number"]),
      provider: string_at(&value, &["executor", "provider"])
        .or_else(|| string_at(&value, &["agentResult", "executor", "provider"])),
      state: string_at(&value, &["state"]).unwrap_or_else(|| "unknown".to_owned()),
      duration_ms: number_at(&value, &["agentResult", "durationMs"]),
    };
    runs.insert(workspace_path, observation);
  }
  runs
}

fn memory_total(commands: &dyn CommandBoundary) -> Option<u64> {
  commands
    .run("sysctl", &["-n", "hw.memsize"])
    .and_then(|value| value.trim().parse().ok())
}

fn vm_stat_used_bytes(total_bytes: u64, stats: &str) -> Option<u64> {
  let page_size = stats.lines().find_map(|line| {
    let prefix = "page size of ";
    let start = line.find(prefix)? + prefix.len();
    line[start..].split_whitespace().next()?.parse::<u64>().ok()
  })?;
  let page_count = |label: &str| -> Option<u64> {
    stats.lines().find_map(|line| {
      let value = line.strip_prefix(label)?.trim().trim_end_matches('.');
      value.parse::<u64>().ok()
    })
  };
  // macOS treats speculative pages as readily reclaimable. Counting them as
  // free avoids presenting cache as committed application memory.
  let free_pages =
    page_count("Pages free:")?.saturating_add(page_count("Pages speculative:").unwrap_or(0));
  total_bytes.checked_sub(free_pages.saturating_mul(page_size))
}

fn memory_stats(commands: &dyn CommandBoundary) -> (Option<u64>, Option<u64>) {
  let total = memory_total(commands);
  let used = total.and_then(|total_bytes| {
    commands
      .run("vm_stat", &[])
      .and_then(|stats| vm_stat_used_bytes(total_bytes, &stats))
  });
  (total, used)
}

fn disk_stats(commands: &dyn CommandBoundary, path: &Path) -> (Option<u64>, Option<u64>) {
  let Some(stats) = commands.run("df", &["-k", path.to_string_lossy().as_ref()]) else {
    return (None, None);
  };
  let Some(line) = stats.lines().last() else {
    return (None, None);
  };
  let columns: Vec<&str> = line.split_whitespace().collect();
  let total = columns
    .get(1)
    .and_then(|value| value.parse::<u64>().ok())
    .map(|value| value * 1024);
  let free = columns
    .get(3)
    .and_then(|value| value.parse::<u64>().ok())
    .map(|value| value * 1024);
  (total, free)
}

fn collect_snapshot(commands: &dyn CommandBoundary) -> Result<ControlTowerSnapshot, String> {
  let root = repository_root(commands)
    .ok_or("無法解析 repository root；請設定 TACHIKO_CONTROL_TOWER_REPOSITORY。")?;
  collect_snapshot_for_root(commands, &root)
}

fn collect_snapshot_for_root(
  commands: &dyn CommandBoundary,
  root: &Path,
) -> Result<ControlTowerSnapshot, String> {
  let root_text = root.to_string_lossy();
  let porcelain = commands
    .run(
      "git",
      &["-C", root_text.as_ref(), "worktree", "list", "--porcelain"],
    )
    .ok_or("無法讀取 git worktree observations。")?;
  let repository = github_repository(commands, &root).unwrap_or_else(|| {
    root
      .file_name()
      .and_then(|value| value.to_str())
      .unwrap_or("unknown")
      .to_owned()
  });
  let runs = load_runs();
  let rows = parse_worktrees(&porcelain)
    .into_iter()
    .map(|entry| {
      let run = runs.get(&entry.path);
      let process = current_process(commands, &entry.path);
      WorkUnitView {
        repository: run
          .map(|value| value.repository.clone())
          .unwrap_or_else(|| repository.clone()),
        // Branch text is not durable identity evidence. A missing run remains unlinked.
        issue: run.and_then(|value| value.issue),
        pull_request: pull_request(
          commands,
          &repository,
          run.and_then(|value| value.pull_request_number),
        ),
        run_id: run.map(|value| value.id.clone()),
        agent: run.map(|value| AgentView {
          provider: value
            .provider
            .clone()
            .unwrap_or_else(|| "unknown".to_owned()),
          profile: None,
          state: value.state.clone(),
          duration_ms: value.duration_ms,
        }),
        worktree: WorktreeView {
          short_id: entry
            .head_sha
            .as_deref()
            .unwrap_or("unknown")
            .chars()
            .take(4)
            .collect(),
          path: entry.path.clone(),
          branch: entry.branch.clone(),
          head_sha: entry.head_sha.clone(),
          clean: is_clean(commands, &entry.path),
        },
        process,
        disk_bytes: directory_bytes(commands, &entry.path),
        reclaim: ReclaimView {
          state: "unknown".to_owned(),
          reason: RECLAIM_UNAVAILABLE.to_owned(),
        },
      }
    })
    .collect();
  let (data_total_bytes, data_free_bytes) = disk_stats(commands, &root);
  let (memory_total_bytes, memory_used_bytes) = memory_stats(commands);
  let generated_at = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map_err(|error| error.to_string())?
    .as_millis()
    .to_string();
  Ok(ControlTowerSnapshot {
    mode: "live",
    generated_at,
    rows,
    system: SystemView { memory_total_bytes, memory_used_bytes, data_total_bytes, data_free_bytes },
    source_note: "Live observations use bounded Git, durable Conductor-run, process, disk and GitHub reads. Unlinked or unproven correlations remain unknown.".to_owned(),
  })
}

fn collect_control_tower_snapshot_inner() -> Result<ControlTowerSnapshot, String> {
  collect_snapshot(&SystemCommands)
}

#[tauri::command]
async fn collect_control_tower_snapshot() -> Result<ControlTowerSnapshot, String> {
  tauri::async_runtime::spawn_blocking(collect_control_tower_snapshot_inner)
    .await
    .map_err(|error| error.to_string())?
}

fn is_executing_state(state: &str) -> bool {
  matches!(
    state.trim().to_ascii_lowercase().as_str(),
    "working"
      | "testing"
      | "implementing"
      | "validating"
      | "reviewing"
      | "changes_requested"
      | "final_gate"
  )
}

fn tray_summary(snapshot: &ControlTowerSnapshot) -> (String, String, String) {
  let active = snapshot
    .rows
    .iter()
    .filter(|row| {
      row
        .agent
        .as_ref()
        .is_some_and(|agent| is_executing_state(&agent.state))
    })
    .count();
  let agents = format!("Codex 執行中：{active}");
  let disk = snapshot
    .system
    .data_free_bytes
    .map(|bytes| format!("Data 磁碟：{:.1} GB 可用", bytes as f64 / 1_000_000_000.0))
    .unwrap_or_else(|| "Data 磁碟：容量未知".to_owned());
  let reclaimable = snapshot
    .rows
    .iter()
    .filter(|row| row.reclaim.state == "reclaimable")
    .count();
  let reclaim = if reclaimable == 0 {
    "可立即回收：尚無已證明項目".to_owned()
  } else {
    format!("可立即回收：{reclaimable} 個 worktree")
  };
  (agents, disk, reclaim)
}

fn unavailable_tray_summary() -> (String, String, String) {
  (
    "Codex 執行中：資料不可用".to_owned(),
    "Data 磁碟：資料不可用".to_owned(),
    "可立即回收：資料不可用".to_owned(),
  )
}

fn tray_summary_for_refresh(
  snapshot: Result<ControlTowerSnapshot, String>,
) -> (String, String, String) {
  snapshot
    .map(|snapshot| tray_summary(&snapshot))
    .unwrap_or_else(|_| unavailable_tray_summary())
}

fn open_control_tower(app: &tauri::AppHandle) {
  if let Some(window) = app.get_webview_window("main") {
    let _ = window.show();
    let _ = window.set_focus();
  }
}

#[derive(Debug, PartialEq, Eq)]
enum TrayAction {
  Open,
  Quit,
  Ignore,
}

fn tray_action(id: &str) -> TrayAction {
  match id {
    "open-control-tower" => TrayAction::Open,
    "quit" => TrayAction::Quit,
    _ => TrayAction::Ignore,
  }
}

pub fn run() {
  tauri::Builder::default()
    .setup(|app| {
      let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| std::io::Error::other("missing bundled Control Tower icon"))?;
      let open = MenuItem::with_id(
        app,
        "open-control-tower",
        "Open Control Tower",
        true,
        None::<&str>,
      )?;
      let agents = MenuItem::with_id(
        app,
        "agents-summary",
        "Codex 執行中：讀取中…",
        false,
        None::<&str>,
      )?;
      let disk = MenuItem::with_id(
        app,
        "disk-summary",
        "Data 磁碟：讀取中…",
        false,
        None::<&str>,
      )?;
      let reclaim = MenuItem::with_id(
        app,
        "reclaim-summary",
        "可立即回收：讀取中…",
        false,
        None::<&str>,
      )?;
      let separator = PredefinedMenuItem::separator(app)?;
      let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
      let menu = Menu::with_items(app, &[&open, &agents, &disk, &reclaim, &separator, &quit])?;
      let agents_for_summary = agents.clone();
      let disk_for_summary = disk.clone();
      let reclaim_for_summary = reclaim.clone();
      thread::spawn(move || loop {
        let (agent_text, disk_text, reclaim_text) =
          tray_summary_for_refresh(collect_control_tower_snapshot_inner());
        let _ = agents_for_summary.set_text(agent_text);
        let _ = disk_for_summary.set_text(disk_text);
        let _ = reclaim_for_summary.set_text(reclaim_text);
        thread::sleep(TRAY_REFRESH_INTERVAL);
      });
      TrayIconBuilder::with_id("control-tower-tray")
        .icon(icon)
        .tooltip("Tachiko\nOperational summary available")
        .menu(&menu)
        .on_menu_event(|app, event| match tray_action(event.id.as_ref()) {
          TrayAction::Open => open_control_tower(app),
          TrayAction::Quit => app.exit(0),
          TrayAction::Ignore => {}
        })
        .build(app)?;
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![collect_control_tower_snapshot])
    .run(tauri::generate_context!())
    .expect("error while running Tachiko Control Tower");
}

#[cfg(test)]
mod tests {
  use super::*;

  struct FakeCommands {
    responses: HashMap<String, String>,
  }

  impl FakeCommands {
    fn with(responses: &[(&str, &str, &str)]) -> Self {
      let responses = responses
        .iter()
        .map(|(program, args, output)| (format!("{program}\u{0}{args}"), (*output).to_owned()))
        .collect();
      Self { responses }
    }
  }

  impl CommandBoundary for FakeCommands {
    fn run(&self, program: &str, args: &[&str]) -> Option<String> {
      self
        .responses
        .get(&format!("{program}\u{0}{}", args.join("\u{1}")))
        .cloned()
    }
  }

  #[test]
  fn live_snapshot_is_a_serializable_fail_closed_read_model() {
    let snapshot =
      collect_control_tower_snapshot_inner().expect("the test worktree is a Git repository");
    let encoded =
      serde_json::to_value(snapshot).expect("snapshot serializes for the Tauri boundary");
    assert!(encoded.get("rows").is_some());
    assert!(encoded.get("system").is_some());
    let rows = encoded
      .get("rows")
      .and_then(Value::as_array)
      .expect("rows are an array");
    assert!(rows.iter().all(|row| row
      .get("reclaim")
      .and_then(|reclaim| reclaim.get("state"))
      .and_then(Value::as_str)
      == Some("unknown")));
  }

  #[test]
  fn macos_vm_stat_is_a_system_memory_observation() {
    let fake = FakeCommands::with(&[
      ("sysctl", "-n\u{1}hw.memsize", "10000\n"),
      ("vm_stat", "", "Mach Virtual Memory Statistics: (page size of 1000 bytes)\nPages free:                               2.\nPages speculative:                        3.\n"),
    ]);
    assert_eq!(memory_stats(&fake), (Some(10_000), Some(5_000)));
  }

  #[test]
  fn injected_system_boundaries_fail_closed_on_missing_outputs() {
    let fake = FakeCommands::with(&[]);
    assert_eq!(memory_stats(&fake), (None, None));
    assert_eq!(disk_stats(&fake, Path::new("/unavailable")), (None, None));
    assert_eq!(is_clean(&fake, "/unavailable"), None);
  }

  #[test]
  fn production_collector_uses_injected_boundaries_and_never_derives_issue_from_branch() {
    let fake = FakeCommands::with(&[
      ("git", "-C\u{1}/tmp/repo\u{1}worktree\u{1}list\u{1}--porcelain", "worktree /tmp/work trees/issue-32\nHEAD 1234567890\nbranch refs/heads/codex/issue-32\n"),
      ("git", "-C\u{1}/tmp/repo\u{1}config\u{1}--get\u{1}remote.origin.url", "https://github.com/nurockplayer/tachiko-conductor.git\n"),
      ("git", "-C\u{1}/tmp/work trees/issue-32\u{1}status\u{1}--porcelain", ""),
      ("du", "-sk\u{1}/tmp/work trees/issue-32", "2048\t/tmp/work trees/issue-32\n"),
      ("df", "-k\u{1}/tmp/repo", "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk 1000 400 600 40% /\n"),
      ("sysctl", "-n\u{1}hw.memsize", "10000\n"),
      ("vm_stat", "", "Mach Virtual Memory Statistics: (page size of 1000 bytes)\nPages free:                               4.\n"),
    ]);
    let snapshot = collect_snapshot_for_root(&fake, Path::new("/tmp/repo"))
      .expect("fake observations are complete enough for a snapshot");
    assert_eq!(snapshot.rows.len(), 1);
    assert_eq!(snapshot.rows[0].worktree.path, "/tmp/work trees/issue-32");
    assert_eq!(snapshot.rows[0].issue, None);
    assert_eq!(snapshot.rows[0].disk_bytes, Some(2_097_152));
    assert_eq!(snapshot.system.memory_used_bytes, Some(6_000));
  }

  #[test]
  fn tray_summary_excludes_terminal_runs_and_reports_safe_reclaim_state() {
    let snapshot = ControlTowerSnapshot {
      mode: "live",
      generated_at: "0".to_owned(),
      rows: vec![
        WorkUnitView {
          repository: "repo".to_owned(),
          issue: None,
          pull_request: None,
          run_id: None,
          agent: Some(AgentView {
            provider: "Codex".to_owned(),
            profile: None,
            state: "MERGED".to_owned(),
            duration_ms: None,
          }),
          worktree: WorktreeView {
            path: "/tmp/a".to_owned(),
            short_id: "aaaa".to_owned(),
            branch: None,
            head_sha: None,
            clean: None,
          },
          process: None,
          disk_bytes: None,
          reclaim: ReclaimView {
            state: "unknown".to_owned(),
            reason: RECLAIM_UNAVAILABLE.to_owned(),
          },
        },
        WorkUnitView {
          repository: "repo".to_owned(),
          issue: None,
          pull_request: None,
          run_id: None,
          agent: Some(AgentView {
            provider: "Codex".to_owned(),
            profile: None,
            state: "VALIDATING".to_owned(),
            duration_ms: None,
          }),
          worktree: WorktreeView {
            path: "/tmp/b".to_owned(),
            short_id: "bbbb".to_owned(),
            branch: None,
            head_sha: None,
            clean: None,
          },
          process: None,
          disk_bytes: None,
          reclaim: ReclaimView {
            state: "reclaimable".to_owned(),
            reason: "proven".to_owned(),
          },
        },
      ],
      system: SystemView {
        memory_total_bytes: None,
        memory_used_bytes: None,
        data_total_bytes: None,
        data_free_bytes: Some(1_500_000_000),
      },
      source_note: "test".to_owned(),
    };
    assert_eq!(
      tray_summary(&snapshot),
      (
        "Codex 執行中：1".to_owned(),
        "Data 磁碟：1.5 GB 可用".to_owned(),
        "可立即回收：1 個 worktree".to_owned()
      )
    );
  }

  #[test]
  fn tray_refresh_replaces_startup_placeholder_after_a_failed_read() {
    assert_eq!(
      tray_summary_for_refresh(Err("transient collector failure".to_owned())),
      (
        "Codex 執行中：資料不可用".to_owned(),
        "Data 磁碟：資料不可用".to_owned(),
        "可立即回收：資料不可用".to_owned()
      )
    );
  }

  #[test]
  fn tray_open_and_quit_events_are_dispatched_only_from_named_actions() {
    assert_eq!(tray_action("open-control-tower"), TrayAction::Open);
    assert_eq!(tray_action("quit"), TrayAction::Quit);
    assert_eq!(tray_action("agents-summary"), TrayAction::Ignore);
  }

  #[test]
  fn process_command_timeout_is_bounded() {
    assert_eq!(
      output_with_timeout("sh", &["-c", "sleep 1"], Duration::from_millis(1)),
      None
    );
  }

  #[test]
  fn bounded_command_runner_drains_verbose_stdout_before_waiting_for_exit() {
    let output = output_with_timeout(
      "sh",
      &["-c", "yes x | head -c 200000"],
      Duration::from_secs(2),
    )
    .expect("a healthy verbose command is not mistaken for a timeout");
    assert_eq!(output.len(), 200_000);
  }

  #[test]
  fn timeout_does_not_wait_for_a_descendant_that_inherits_stdout() {
    let started = Instant::now();
    assert_eq!(
      output_with_timeout("sh", &["-c", "sleep 60 &"], Duration::from_millis(40)),
      None
    );
    assert!(started.elapsed() < Duration::from_secs(1));
  }
}
