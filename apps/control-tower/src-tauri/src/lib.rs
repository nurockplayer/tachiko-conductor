use std::{
  collections::HashMap,
  env,
  fs,
  path::{Path, PathBuf},
  process::Command,
  time::{SystemTime, UNIX_EPOCH},
};

use serde::Serialize;
use serde_json::Value;
use tauri::{
  menu::{Menu, MenuItem, PredefinedMenuItem},
  tray::TrayIconBuilder,
  Manager,
};

const RECLAIM_UNAVAILABLE: &str = "安全回收分類器尚不可用；未推定可刪除。";

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
  provider: Option<String>,
  state: String,
  duration_ms: Option<u64>,
}

fn output(program: &str, args: &[&str]) -> Option<String> {
  Command::new(program).args(args).output().ok().and_then(|result| {
    if result.status.success() {
      String::from_utf8(result.stdout).ok()
    } else {
      None
    }
  })
}

fn repository_root() -> Option<PathBuf> {
  let candidate = env::var_os("TACHIKO_CONTROL_TOWER_REPOSITORY")
    .map(PathBuf::from)
    .or_else(|| env::current_dir().ok())?;
  output("git", &["-C", candidate.to_string_lossy().as_ref(), "rev-parse", "--show-toplevel"])
    .map(|root| PathBuf::from(root.trim()))
}

fn parse_worktrees(porcelain: &str) -> Vec<ParsedWorktree> {
  porcelain.split("\n\n").filter_map(|block| {
    let mut entry = ParsedWorktree::default();
    for line in block.lines() {
      if let Some(value) = line.strip_prefix("worktree ") { entry.path = value.to_owned(); }
      if let Some(value) = line.strip_prefix("HEAD ") { entry.head_sha = Some(value.to_owned()); }
      if let Some(value) = line.strip_prefix("branch ") { entry.branch = Some(value.trim_start_matches("refs/heads/").to_owned()); }
    }
    (!entry.path.is_empty()).then_some(entry)
  }).collect()
}

fn is_clean(path: &str) -> Option<bool> {
  output("git", &["-C", path, "status", "--porcelain"])
    .map(|status| status.trim().is_empty())
}

fn directory_bytes(path: &str) -> Option<u64> {
  output("du", &["-sk", path]).and_then(|result| {
    result.split_whitespace().next()?.parse::<u64>().ok().map(|kilobytes| kilobytes * 1024)
  })
}

fn current_process(path: &str) -> Option<ProcessView> {
  // Exact-path lsof is deliberately narrow: absence is not treated as proof of idleness.
  let pids = output("lsof", &["-t", "--", path])?;
  let pid = pids.lines().find_map(|line| line.trim().parse::<u32>().ok())?;
  let rss_bytes = output("ps", &["-o", "rss=", "-p", &pid.to_string()])
    .and_then(|rss| rss.trim().parse::<u64>().ok())
    .map(|kilobytes| kilobytes * 1024);
  Some(ProcessView { pid, rss_bytes, state: "observed".to_owned() })
}

fn github_repository(root: &Path) -> Option<String> {
  let root_text = root.to_string_lossy();
  let remote = output("git", &["-C", root_text.as_ref(), "config", "--get", "remote.origin.url"])?;
  let remote = remote.trim().trim_end_matches(".git");
  remote.strip_prefix("git@github.com:")
    .or_else(|| remote.strip_prefix("https://github.com/"))
    .filter(|value| value.split('/').count() == 2)
    .map(str::to_owned)
}

fn pull_request(repository: &str, branch: Option<&str>) -> Option<PullRequestView> {
  let branch = branch?;
  let json = output("gh", &["pr", "list", "--repo", repository, "--head", branch, "--state", "all", "--limit", "1", "--json", "number,state"])?;
  let entries: Vec<Value> = serde_json::from_str(&json).ok()?;
  let item = entries.first()?;
  Some(PullRequestView {
    number: item.get("number")?.as_u64()?,
    state: item.get("state")?.as_str()?.to_owned(),
  })
}

fn issue_from_branch(branch: Option<&str>) -> Option<u64> {
  let branch = branch?;
  let marker = branch.find("issue-")? + "issue-".len();
  branch[marker..].chars().take_while(|character| character.is_ascii_digit()).collect::<String>().parse().ok()
}

fn run_directory() -> Option<PathBuf> {
  env::var_os("TACHIKO_DATA_DIR").map(PathBuf::from).or_else(|| env::var_os("HOME").map(|home| PathBuf::from(home).join(".tachiko-conductor/runs")))
}

fn string_at(value: &Value, path: &[&str]) -> Option<String> {
  let mut cursor = value;
  for key in path { cursor = cursor.get(*key)?; }
  cursor.as_str().map(str::to_owned)
}

fn number_at(value: &Value, path: &[&str]) -> Option<u64> {
  let mut cursor = value;
  for key in path { cursor = cursor.get(*key)?; }
  cursor.as_u64()
}

fn load_runs() -> HashMap<String, RunObservation> {
  let mut runs = HashMap::new();
  let Some(directory) = run_directory() else { return runs; };
  let Ok(entries) = fs::read_dir(directory) else { return runs; };
  for entry in entries.flatten() {
    if entry.path().extension().and_then(|extension| extension.to_str()) != Some("json") { continue; }
    let Ok(raw) = fs::read_to_string(entry.path()) else { continue; };
    let Ok(value) = serde_json::from_str::<Value>(&raw) else { continue; };
    let Some(workspace_path) = string_at(&value, &["bootstrap", "workspacePath"]) else { continue; };
    let observation = RunObservation {
      id: string_at(&value, &["id"]).unwrap_or_default(),
      repository: string_at(&value, &["target", "repo"]).unwrap_or_else(|| "unknown".to_owned()),
      issue: number_at(&value, &["target", "issueNumber"]),
      provider: string_at(&value, &["executor", "provider"]).or_else(|| string_at(&value, &["agentResult", "executor", "provider"])),
      state: string_at(&value, &["state"]).unwrap_or_else(|| "unknown".to_owned()),
      duration_ms: number_at(&value, &["agentResult", "durationMs"]),
    };
    runs.insert(workspace_path, observation);
  }
  runs
}

fn memory_total() -> Option<u64> {
  output("sysctl", &["-n", "hw.memsize"]).and_then(|value| value.trim().parse().ok())
}

fn disk_stats(path: &Path) -> (Option<u64>, Option<u64>) {
  let Some(stats) = output("df", &["-k", path.to_string_lossy().as_ref()]) else { return (None, None); };
  let Some(line) = stats.lines().last() else { return (None, None); };
  let columns: Vec<&str> = line.split_whitespace().collect();
  let total = columns.get(1).and_then(|value| value.parse::<u64>().ok()).map(|value| value * 1024);
  let free = columns.get(3).and_then(|value| value.parse::<u64>().ok()).map(|value| value * 1024);
  (total, free)
}

#[tauri::command]
fn collect_control_tower_snapshot() -> Result<ControlTowerSnapshot, String> {
  let root = repository_root().ok_or("無法解析 repository root；請設定 TACHIKO_CONTROL_TOWER_REPOSITORY。")?;
  let root_text = root.to_string_lossy();
  let porcelain = output("git", &["-C", root_text.as_ref(), "worktree", "list", "--porcelain"])
    .ok_or("無法讀取 git worktree observations。")?;
  let repository = github_repository(&root).unwrap_or_else(|| root.file_name().and_then(|value| value.to_str()).unwrap_or("unknown").to_owned());
  let runs = load_runs();
  let rows = parse_worktrees(&porcelain).into_iter().map(|entry| {
    let run = runs.get(&entry.path);
    let process = current_process(&entry.path);
    WorkUnitView {
      repository: run.map(|value| value.repository.clone()).unwrap_or_else(|| repository.clone()),
      issue: run.and_then(|value| value.issue).or_else(|| issue_from_branch(entry.branch.as_deref())),
      pull_request: pull_request(&repository, entry.branch.as_deref()),
      run_id: run.map(|value| value.id.clone()),
      agent: run.map(|value| AgentView { provider: value.provider.clone().unwrap_or_else(|| "unknown".to_owned()), profile: None, state: value.state.clone(), duration_ms: value.duration_ms }),
      worktree: WorktreeView { short_id: entry.head_sha.as_deref().unwrap_or("unknown").chars().take(4).collect(), path: entry.path.clone(), branch: entry.branch.clone(), head_sha: entry.head_sha.clone(), clean: is_clean(&entry.path) },
      process,
      disk_bytes: directory_bytes(&entry.path),
      reclaim: ReclaimView { state: "unknown".to_owned(), reason: RECLAIM_UNAVAILABLE.to_owned() },
    }
  }).collect();
  let (data_total_bytes, data_free_bytes) = disk_stats(&root);
  let generated_at = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|error| error.to_string())?.as_millis().to_string();
  Ok(ControlTowerSnapshot {
    mode: "live",
    generated_at,
    rows,
    system: SystemView { memory_total_bytes: memory_total(), memory_used_bytes: None, data_total_bytes, data_free_bytes },
    source_note: "Live observations use bounded Git, durable Conductor-run, process, disk and GitHub reads. Unlinked or unproven correlations remain unknown.".to_owned(),
  })
}

pub fn run() {
  tauri::Builder::default()
    .setup(|app| {
      let icon = app.default_window_icon().cloned().ok_or_else(|| std::io::Error::other("missing bundled Control Tower icon"))?;
      let open = MenuItem::with_id(app, "open-control-tower", "Open Control Tower", true, None::<&str>)?;
      let separator = PredefinedMenuItem::separator(app)?;
      let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
      let menu = Menu::with_items(app, &[&open, &separator, &quit])?;
      TrayIconBuilder::with_id("control-tower-tray")
        .icon(icon)
        .tooltip("Tachiko\nOperational summary available")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id.as_ref() {
          "open-control-tower" => {
            if let Some(window) = app.get_webview_window("main") {
              let _ = window.show();
              let _ = window.set_focus();
            }
          }
          "quit" => app.exit(0),
          _ => {}
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

  #[test]
  fn live_snapshot_is_a_serializable_fail_closed_read_model() {
    let snapshot = collect_control_tower_snapshot().expect("the test worktree is a Git repository");
    let encoded = serde_json::to_value(snapshot).expect("snapshot serializes for the Tauri boundary");
    assert!(encoded.get("rows").is_some());
    assert!(encoded.get("system").is_some());
    let rows = encoded.get("rows").and_then(Value::as_array).expect("rows are an array");
    assert!(rows.iter().all(|row| row.get("reclaim").and_then(|reclaim| reclaim.get("state")).and_then(Value::as_str) == Some("unknown")));
  }
}
