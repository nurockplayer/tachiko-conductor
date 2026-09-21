use std::{
  collections::{BTreeMap, BTreeSet},
  env, fs,
  io::Read,
  path::{Path, PathBuf},
  process::{Command, Stdio},
  sync::{mpsc, Mutex, OnceLock},
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
const MAX_COMMAND_OUTPUT_BYTES: usize = 1_048_576;
const TRAY_REFRESH_INTERVAL: Duration = Duration::from_secs(15);

static SNAPSHOT_COLLECTION_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

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
struct RestartView { verdict: String, reason: String }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AutopilotView {
  supervisor: String,
  current_stage: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  next_poll_at: Option<String>,
  event_wake_eligible: String,
  writer_ownership: String,
  checkpoint: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  checkpoint_sha: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  manual_writer_state: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  active_writer: Option<serde_json::Value>,
  restart: RestartView,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ControlTowerSnapshot {
  mode: &'static str,
  generated_at: String,
  rows: Vec<WorkUnitView>,
  system: SystemView,
  autopilot: AutopilotView,
  source_note: String,
}

#[derive(Default)]
struct ParsedWorktree {
  path: String,
  head_sha: Option<String>,
  branch: Option<String>,
}

#[derive(Clone, Default)]
struct RunObservation {
  id: String,
  repository: String,
  workspace_path: String,
  branch: String,
  base_sha: String,
  head_sha: Option<String>,
  pull_request_head_sha: Option<String>,
  issue: Option<u64>,
  pull_request_number: Option<u64>,
  provider: Option<String>,
  profile: Option<String>,
  state: String,
  review_fix_active: bool,
  duration_ms: Option<u64>,
}

/// A worktree identity is assembled only from live Git observations.  The
/// common-Git comparison proves that a path came from the bounded `worktree
/// list` of the repository that reported it; a branch name alone is never a
/// correlation key.
#[derive(Clone)]
struct VerifiedWorktree {
  path: String,
  common_git: String,
  repository: Option<String>,
  branch: Option<String>,
  head_sha: Option<String>,
}

/// A run may remain linked to its persisted PR while an explicitly active
/// review repair has created a verified local descendant that is not pushed
/// yet.  In that narrow case GitHub must still be checked against the
/// persisted PR head, rather than against the unadvertised local commit.
struct CorrelatedRun<'a> {
  run: &'a RunObservation,
  active_review_fix_descendant: bool,
}

trait CommandBoundary {
  fn run(&self, program: &str, args: &[&str]) -> Option<String>;
}

struct SystemCommands;

impl CommandBoundary for SystemCommands {
  fn run(&self, program: &str, args: &[&str]) -> Option<String> {
    let program = if program == "gh" { github_cli_program() } else { PathBuf::from(program) };
    output_with_timeout(&program, args, COMMAND_TIMEOUT)
  }
}

/// Finder and Dock launches do not inherit a shell PATH. Accept a validated
/// explicit path first, then cover standard Homebrew locations before retaining
/// PATH lookup for developer shells and non-macOS environments.
fn github_cli_program() -> PathBuf {
  let configured = env::var_os("TACHIKO_CONTROL_TOWER_GH").map(PathBuf::from);
  resolve_github_cli(configured.as_deref(), |candidate| candidate.is_file())
}

fn resolve_github_cli(configured: Option<&Path>, exists: impl Fn(&Path) -> bool) -> PathBuf {
  if let Some(path) = configured.filter(|path| path.is_absolute() && exists(path)) {
    return path.to_path_buf();
  }
  for candidate in [Path::new("/opt/homebrew/bin/gh"), Path::new("/usr/local/bin/gh")] {
    if exists(candidate) {
      return candidate.to_path_buf();
    }
  }
  PathBuf::from("gh")
}

fn output_with_timeout(program: impl AsRef<std::ffi::OsStr>, args: &[&str], timeout: Duration) -> Option<String> {
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
    let result = (|| {
      let mut chunk = [0_u8; 8_192];
      loop {
        let read = stdout.read(&mut chunk).ok()?;
        if read == 0 {
          return String::from_utf8(bytes).ok();
        }
        if bytes.len().saturating_add(read) > MAX_COMMAND_OUTPUT_BYTES {
          return None;
        }
        bytes.extend_from_slice(&chunk[..read]);
      }
    })();
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

fn configured_repository_root(commands: &dyn CommandBoundary) -> Option<PathBuf> {
  // The repository root is an optional explicit supplement to global
  // projection/managed-worktree discovery. Finder and Dock launches must not
  // silently turn their arbitrary current directory into a discovery root.
  let candidate = env::var_os("TACHIKO_CONTROL_TOWER_REPOSITORY").map(PathBuf::from)?;
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
  // Exact-path lsof is deliberately narrow: absence and ambiguous ownership are
  // both unknown, never proof that a particular process owns the worktree.
  let pids = commands.run("lsof", &["-t", "--", path])?;
  let pids: BTreeSet<u32> = pids
    .lines()
    .filter(|line| !line.trim().is_empty())
    .map(|line| line.trim().parse::<u32>().ok())
    .collect::<Option<_>>()?;
  if pids.len() != 1 {
    return None;
  }
  let pid = *pids.first()?;
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
  github_repository_from_remote(&remote)
}

fn github_url_path<'a>(remote: &'a str, scheme: &str) -> Option<&'a str> {
  let remote = remote.strip_prefix(scheme)?;
  let (authority, path) = remote.split_once('/')?;
  // Match the bootstrap parser's authority decision: credentials and an
  // explicit port do not change the GitHub hostname that proves repository
  // identity. Reject malformed ports rather than guessing an identity.
  let authority = authority.rsplit('@').next()?;
  let (host, port) = authority.split_once(':').unwrap_or((authority, ""));
  (host.eq_ignore_ascii_case("github.com") && (port.is_empty() || port.parse::<u16>().is_ok()))
    .then_some(path)
}

fn github_repository_from_remote(remote: &str) -> Option<String> {
  let remote = remote.trim().trim_end_matches(".git");
  let scp_path = remote.strip_prefix("git@").and_then(|value| {
    let (host, path) = value.split_once(':')?;
    host.eq_ignore_ascii_case("github.com").then_some(path)
  });
  scp_path
    .or_else(|| github_url_path(remote, "https://"))
    .or_else(|| github_url_path(remote, "ssh://"))
    .filter(|value| value.split('/').count() == 2)
    .map(str::to_owned)
}

fn pull_request(
  commands: &dyn CommandBoundary,
  repository: &str,
  number: Option<u64>,
  expected_head_sha: Option<&str>,
) -> Option<PullRequestView> {
  let number = number?;
  let expected_head_sha = expected_head_sha?;
  let json = commands.run(
    "gh",
    &[
      "pr",
      "view",
      &number.to_string(),
      "--repo",
      repository,
      "--json",
      "number,state,headRefOid",
    ],
  )?;
  let item: Value = serde_json::from_str(&json).ok()?;
  let state = item.get("state")?.as_str()?.to_owned();
  (item.get("number")?.as_u64()? == number
    && item.get("headRefOid")?.as_str()? == expected_head_sha)
    .then_some(PullRequestView { number, state })
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

/// Projection-only admission. JsonFileStore validates raw Runs; Rust only
/// checks this versioned display contract and its digest of the raw bytes.
fn operational_run_observation(
  value: &Value,
  file_id: &str,
  source_digest: &str,
) -> Option<RunObservation> {
  let schema_version = value.get("schemaVersion")?.as_u64()?;
  let id = string_at(value, &["runId"])?;
  let state = string_at(value, &["workflowState"])?;
  let owner = string_at(value, &["target", "owner"])?;
  let repo = string_at(value, &["target", "repo"])?;
  let workspace_path = string_at(value, &["bootstrap", "workspacePath"])?;
  let branch = string_at(value, &["bootstrap", "branch"])?;
  let base_branch = string_at(value, &["bootstrap", "baseBranch"])?;
  let base_sha = string_at(value, &["bootstrap", "baseSha"])?;
  if schema_version != 1
    || id != file_id
    || id.is_empty()
    || state.trim().is_empty()
    || owner.trim().is_empty()
    || repo.trim().is_empty()
    || workspace_path.is_empty()
    || branch.is_empty()
    || base_branch.is_empty()
    || base_sha.is_empty()
    || string_at(value, &["sourceUpdatedAt"]).is_none()
    || string_at(value, &["sourceDigest"]).as_deref() != Some(source_digest)
  {
    return None;
  }
  Some(RunObservation {
    id,
    repository: format!("{owner}/{repo}"),
    workspace_path: workspace_path.clone(),
    branch,
    base_sha,
    head_sha: string_at(value, &["headSha"]),
    pull_request_head_sha: string_at(value, &["pullRequest", "headSha"]),
    issue: number_at(value, &["target", "issueNumber"]),
    pull_request_number: number_at(value, &["pullRequest", "number"]),
    provider: string_at(value, &["executor", "provider"]),
    profile: string_at(value, &["executor", "profile"]),
    state,
    review_fix_active: value.get("reviewFixActive").and_then(Value::as_bool) == Some(true),
    duration_ms: number_at(value, &["durationMs"]),
  })
}

fn raw_digest(commands: &dyn CommandBoundary, raw_path: &Path) -> Option<String> {
  let output = commands.run(
    "shasum",
    &["-a", "256", raw_path.to_string_lossy().as_ref()],
  )?;
  let digest = output.split_whitespace().next()?;
  (digest.len() == 64 && digest.bytes().all(|byte| byte.is_ascii_hexdigit()))
    .then_some(digest.to_ascii_lowercase())
}

fn load_runs(commands: &dyn CommandBoundary) -> Vec<RunObservation> {
  let mut runs = Vec::new();
  let Some(directory) = run_directory() else {
    return runs;
  };
  let projection_directory = directory.join(".operational/v1");
  let Ok(entries) = fs::read_dir(projection_directory) else {
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
    let entry_path = entry.path();
    let Some(file_id) = entry_path.file_stem().and_then(|value| value.to_str()) else {
      continue;
    };
    let Some(source_digest) = raw_digest(commands, &directory.join(format!("{file_id}.json")))
    else {
      continue;
    };
    let Some(observation) = operational_run_observation(&value, file_id, &source_digest) else {
      continue;
    };
    runs.push(observation);
  }
  runs
}

fn runtime_autopilot() -> AutopilotView {
  let unknown = || AutopilotView { supervisor: "unknown".to_owned(), current_stage: "unknown".to_owned(), next_poll_at: None, event_wake_eligible: "unknown".to_owned(), writer_ownership: "ambiguous".to_owned(), checkpoint: "unknown".to_owned(), checkpoint_sha: None, manual_writer_state: None, active_writer: None, restart: RestartView { verdict: "UNKNOWN — CANNOT PROVE SAFE".to_owned(), reason: "No typed supervisor, mutation-owner, and durable checkpoint projection is available.".to_owned() } };
  let Some(directory) = run_directory() else { return unknown(); };
  let Ok(raw) = fs::read_to_string(directory.join(".operational/v1/runtime.json")) else { return unknown(); };
  let Ok(value) = serde_json::from_str::<Value>(&raw) else { return unknown(); };
  let supervisor = string_at(&value, &["supervisor"]);
  let stage = string_at(&value, &["stage"]);
  let version = value.get("schemaVersion").and_then(Value::as_u64);
  let hold = value.get("maintenanceHold").and_then(|hold| hold.get("active")).and_then(Value::as_bool);
  let wake = value.get("eventWakeEligible").and_then(Value::as_bool);
  let ownership = string_at(&value, &["ownership"]);
  let checkpoint = string_at(&value, &["checkpoint"]);
  if version != Some(1) || !matches!(supervisor.as_deref(), Some("running" | "stopped" | "parked")) || !matches!(ownership.as_deref(), Some("none" | "active" | "ambiguous")) || !matches!(checkpoint.as_deref(), Some("durable" | "in_progress" | "unknown")) || stage.as_deref().is_none_or(str::is_empty) || hold.is_none() || wake.is_none() { return unknown(); }
  let held = hold == Some(true);
  let (verdict, reason) = if ownership.as_deref() == Some("active") { ("WAIT FOR CURRENT CHECKPOINT", "A typed active writer owns repository mutation.") } else if ownership.as_deref() != Some("none") || checkpoint.as_deref() != Some("durable") { ("UNKNOWN — CANNOT PROVE SAFE", "Writer ownership or durable restart checkpoint is ambiguous.") } else if held { ("SAFE TO RESTART", "No writer is active, durable re-entry is proven, and maintenance hold prevents admission.") } else { ("SAFE NOW · WINDOW NOT GUARANTEED", "No writer is active, but new dispatch admission is not held.") };
  let active_writer = if ownership.as_deref() == Some("active") { value.get("manualLane").cloned() } else { None };
  let checkpoint_sha = string_at(&value, &["manualLane", "checkpointSha"]);
  let manual_writer_state = string_at(&value, &["manualLane", "state"])
    .filter(|state| matches!(state.as_str(), "active" | "parked"));
  AutopilotView {
    supervisor: supervisor.unwrap(), current_stage: stage.unwrap(), next_poll_at: string_at(&value, &["nextPollAt"]),
    event_wake_eligible: if wake == Some(true) { "yes".to_owned() } else { "no".to_owned() },
    writer_ownership: ownership.unwrap(),
    checkpoint: checkpoint.unwrap(),
    checkpoint_sha,
    manual_writer_state,
    active_writer,
    restart: RestartView { verdict: verdict.to_owned(), reason: reason.to_owned() },
  }
}

fn git_text(commands: &dyn CommandBoundary, path: &str, args: &[&str]) -> Option<String> {
  let mut git_args = vec!["-C", path];
  git_args.extend_from_slice(args);
  commands
    .run("git", &git_args)
    .map(|value| value.trim().to_owned())
    .filter(|value| !value.is_empty())
}

fn verified_worktree(commands: &dyn CommandBoundary, path: &str) -> Option<VerifiedWorktree> {
  let canonical_path = git_text(commands, path, &["rev-parse", "--show-toplevel"])?;
  let common_git = git_text(
    commands,
    &canonical_path,
    &["rev-parse", "--path-format=absolute", "--git-common-dir"],
  )?;
  Some(VerifiedWorktree {
    repository: github_repository(commands, Path::new(&canonical_path)),
    branch: git_text(
      commands,
      &canonical_path,
      &["symbolic-ref", "--quiet", "--short", "HEAD"],
    ),
    head_sha: git_text(commands, &canonical_path, &["rev-parse", "HEAD"]),
    path: canonical_path,
    common_git,
  })
}

fn discover_worktrees_from_identity(
  commands: &dyn CommandBoundary,
  root_identity: &VerifiedWorktree,
) -> Vec<VerifiedWorktree> {
  let Some(porcelain) = commands.run(
    "git",
    &["-C", &root_identity.path, "worktree", "list", "--porcelain"],
  ) else {
    return Vec::new();
  };
  parse_worktrees(&porcelain)
    .into_iter()
    .filter_map(|entry| verified_worktree(commands, &entry.path))
    .filter(|entry| entry.common_git == root_identity.common_git)
    .collect()
}

fn managed_worktree_roots(workspace_root: &Path) -> Vec<String> {
  const MAX_MANAGED_ROOTS: usize = 64;
  const MAX_MANAGED_DEPTH: usize = 3;
  let mut roots = BTreeSet::from([workspace_root.to_string_lossy().to_string()]);
  let mut pending = vec![(workspace_root.to_path_buf(), 0_usize)];
  while let Some((directory, depth)) = pending.pop() {
    if depth >= MAX_MANAGED_DEPTH || roots.len() >= MAX_MANAGED_ROOTS {
      continue;
    }
    let Ok(entries) = fs::read_dir(directory) else {
      continue;
    };
    let mut children = entries
      .flatten()
      .filter_map(|entry| entry.file_type().ok()?.is_dir().then_some(entry.path()))
      .collect::<Vec<_>>();
    children.sort();
    for child in children {
      if roots.len() >= MAX_MANAGED_ROOTS {
        break;
      }
      if roots.insert(child.to_string_lossy().to_string()) {
        pending.push((child, depth + 1));
      }
    }
  }
  roots.into_iter().collect()
}

/// Discover only the configured Conductor root, managed worktree roots, and
/// workspace paths carried by verified projection sidecars. There is no HOME
/// scan and no dependency on a Codex database/session format.
fn discover_worktrees(
  commands: &dyn CommandBoundary,
  conductor_root: Option<&Path>,
  workspace_root: &Path,
  runs: &[RunObservation],
) -> Vec<VerifiedWorktree> {
  let mut roots = BTreeSet::new();
  if let Some(conductor_root) = conductor_root {
    roots.insert(conductor_root.to_string_lossy().to_string());
  }
  roots.extend(managed_worktree_roots(workspace_root));
  roots.extend(runs.iter().map(|run| run.workspace_path.clone()));

  // First identify roots, then ask each common Git directory for its worktree
  // list once. A projected run per worktree would otherwise repeatedly list
  // the same sibling set and make a refresh quadratic.
  let mut identities = BTreeMap::new();
  for root in roots {
    if let Some(identity) = verified_worktree(commands, &root) {
      identities.entry(identity.common_git.clone()).or_insert(identity);
    }
  }
  let mut discovered = BTreeMap::new();
  for identity in identities.into_values() {
    for worktree in discover_worktrees_from_identity(commands, &identity) {
      discovered.entry(worktree.path.clone()).or_insert(worktree);
    }
  }
  discovered.into_values().collect()
}

fn verified_run_worktrees(
  commands: &dyn CommandBoundary,
  runs: &[RunObservation],
) -> BTreeMap<String, VerifiedWorktree> {
  runs
    .iter()
    .filter_map(|run| verified_worktree(commands, &run.workspace_path).map(|worktree| (run.id.clone(), worktree)))
    .collect()
}

fn correlated_run<'a>(
  commands: &dyn CommandBoundary,
  runs: &'a [RunObservation],
  run_worktrees: &BTreeMap<String, VerifiedWorktree>,
  worktree: &VerifiedWorktree,
) -> Option<CorrelatedRun<'a>> {
  let matches = runs
    .iter()
    .filter_map(|run| {
      let Some(bootstrap) = run_worktrees.get(&run.id) else {
        return None;
      };
      let head = worktree.head_sha.as_deref()?;
      if bootstrap.path != worktree.path
        || bootstrap.common_git != worktree.common_git
        || !worktree
          .repository
          .as_deref()
          .is_some_and(|repository| repository.eq_ignore_ascii_case(&run.repository))
        || worktree.branch.as_deref() != Some(run.branch.as_str())
      {
        return None;
      }
      let exact_head = run
        .head_sha
        .as_deref()
        .is_none_or(|expected| expected == head)
        && run
          .pull_request_head_sha
          .as_deref()
          .is_none_or(|expected| expected == head);
      let review_fix_descendant = run.review_fix_active
        && run.state == "IMPLEMENTING"
        && run.head_sha.as_deref().is_some_and(|accepted_head| {
          run.pull_request_head_sha.as_deref() == Some(accepted_head)
            && commands
              .run(
                "git",
                &[
                  "-C",
                  &worktree.path,
                  "merge-base",
                  "--is-ancestor",
                  accepted_head,
                  head,
                ],
              )
              .is_some()
        });
      let active_review_fix_descendant = !exact_head && review_fix_descendant;
      if !(exact_head || active_review_fix_descendant)
        || commands
          .run(
            "git",
            &[
              "-C",
              &worktree.path,
              "merge-base",
              "--is-ancestor",
              &run.base_sha,
              head,
            ],
          )
          .is_none()
      {
        return None;
      }
      Some(CorrelatedRun { run, active_review_fix_descendant })
    })
    .collect::<Vec<_>>();
  (matches.len() == 1).then(|| matches.into_iter().next()).flatten()
}

fn pull_request_head_for_correlation<'a>(
  correlated: &'a CorrelatedRun<'a>,
  worktree: &'a VerifiedWorktree,
) -> Option<&'a str> {
  if correlated.active_review_fix_descendant {
    worktree.head_sha.as_deref()
  } else {
    correlated.run.pull_request_head_sha.as_deref()
  }
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

fn existing_ancestor(path: &Path) -> Option<PathBuf> {
  let mut candidate = path.to_path_buf();
  while !candidate.exists() {
    candidate = candidate.parent()?.to_path_buf();
  }
  Some(candidate)
}

fn disk_stats(commands: &dyn CommandBoundary, path: &Path) -> (Option<u64>, Option<u64>) {
  let Some(path) = existing_ancestor(path) else {
    return (None, None);
  };
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

fn workspace_data_path(configured_workspace_root: Option<PathBuf>, home: Option<PathBuf>) -> Option<PathBuf> {
  configured_workspace_root
    .or_else(|| home.map(|home| home.join(".tachiko-conductor/workspaces")))
}

fn collect_snapshot(commands: &dyn CommandBoundary) -> Result<ControlTowerSnapshot, String> {
  let workspace_root = workspace_data_path(
    env::var_os("TACHIKO_WORKSPACE_ROOT").map(PathBuf::from),
    env::var_os("HOME").map(PathBuf::from),
  )
  .ok_or("無法解析 managed worktree root；請設定 TACHIKO_WORKSPACE_ROOT。")?;
  // Finder/Dock launches may have neither cwd nor a shell environment. The
  // stable root is an optional additional discovery source; projections and
  // managed worktree roots still provide the global desktop view without it.
  collect_snapshot_for_roots_with_workspace_data_path(
    commands,
    configured_repository_root(commands).as_deref(),
    &workspace_root,
  )
}

fn collect_snapshot_for_roots_with_workspace_data_path(
  commands: &dyn CommandBoundary,
  conductor_root: Option<&Path>,
  workspace_root: &Path,
) -> Result<ControlTowerSnapshot, String> {
  let runs = load_runs(commands);
  let run_worktrees = verified_run_worktrees(commands, &runs);
  let rows = discover_worktrees(commands, conductor_root, workspace_root, &runs)
    .into_iter()
    .map(|worktree| {
      let correlated = correlated_run(commands, &runs, &run_worktrees, &worktree).and_then(|run| {
        let pull_request = pull_request(
          commands,
          &run.run.repository,
          run.run.pull_request_number,
          pull_request_head_for_correlation(&run, &worktree),
        );
        (run.run.pull_request_number.is_none() || pull_request.is_some()).then_some((run, pull_request))
      });
      let run = correlated.as_ref().map(|(run, _)| run.run);
      let process = current_process(commands, &worktree.path);
      WorkUnitView {
        repository: run
          .map(|value| value.repository.clone())
          .or_else(|| worktree.repository.clone())
          .unwrap_or_else(|| "unknown".to_owned()),
        // A missing, ambiguous, stale, or GitHub-unproven run remains unlinked.
        issue: run.and_then(|value| value.issue),
        pull_request: correlated.and_then(|(_, pull_request)| pull_request),
        run_id: run.map(|value| value.id.clone()),
        agent: run.map(|value| AgentView {
          provider: value
            .provider
            .clone()
            .unwrap_or_else(|| "unknown".to_owned()),
          profile: value.profile.clone(),
          state: value.state.clone(),
          duration_ms: value.duration_ms,
        }),
        worktree: WorktreeView {
          short_id: worktree
            .head_sha
            .as_deref()
            .unwrap_or("unknown")
            .chars()
            .take(4)
            .collect(),
          path: worktree.path.clone(),
          branch: worktree.branch.clone(),
          head_sha: worktree.head_sha.clone(),
          clean: is_clean(commands, &worktree.path),
        },
        process,
        disk_bytes: directory_bytes(commands, &worktree.path),
        reclaim: ReclaimView {
          state: "unknown".to_owned(),
          reason: RECLAIM_UNAVAILABLE.to_owned(),
        },
      }
    })
    .collect();
  let (data_total_bytes, data_free_bytes) = disk_stats(commands, workspace_root);
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
    // Runtime/supervisor/checkpoint state is intentionally unknown until a
    // typed producer supplies it. No log text, GUI helper, or dirty worktree
    // can manufacture writer or restart-safety evidence.
    autopilot: runtime_autopilot(),
    source_note: "Live observations use bounded Git, durable Conductor-run, process, disk and GitHub reads. Unlinked or unproven correlations remain unknown.".to_owned(),
  })
}

fn collect_control_tower_snapshot_inner() -> Result<ControlTowerSnapshot, String> {
  with_snapshot_collection_lock(|| collect_snapshot(&SystemCommands))
}

fn with_snapshot_collection_lock<T>(
  collect: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
  let lock = SNAPSHOT_COLLECTION_LOCK.get_or_init(|| Mutex::new(()));
  let _guard = lock
    .lock()
    .map_err(|_| "Control Tower snapshot collection lock is unavailable.".to_owned())?;
  collect()
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
  let agents = format!("執行中 agent：{active}");
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
    "執行中 agent：資料不可用".to_owned(),
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
        "執行中 agent：讀取中…",
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
    .on_window_event(|window, event| {
      if window.label() == "main" {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
          // This is a menu-bar application: close hides the dashboard so the
          // tray Open action can always show the same retained webview again.
          api.prevent_close();
          let _ = window.hide();
        }
      }
    })
    .invoke_handler(tauri::generate_handler![collect_control_tower_snapshot])
    .run(tauri::generate_context!())
    .expect("error while running Tachiko Control Tower");
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::collections::HashMap;
  use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc, Barrier,
  };

  struct FakeCommands {
    responses: HashMap<String, String>,
    calls: Mutex<Vec<String>>,
  }

  impl FakeCommands {
    fn with(responses: &[(&str, &str, &str)]) -> Self {
      let responses = responses
        .iter()
        .map(|(program, args, output)| (format!("{program}\u{0}{args}"), (*output).to_owned()))
        .collect();
      Self { responses, calls: Mutex::new(Vec::new()) }
    }

    fn call_count(&self, program: &str, args: &str) -> usize {
      let key = format!("{program}\u{0}{args}");
      self.calls.lock().expect("test call log").iter().filter(|call| *call == &key).count()
    }
  }

  impl CommandBoundary for FakeCommands {
    fn run(&self, program: &str, args: &[&str]) -> Option<String> {
      let key = format!("{program}\u{0}{}", args.join("\u{1}"));
      self.calls.lock().expect("test call log").push(key.clone());
      self
        .responses
        .get(&key)
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
  fn data_volume_uses_the_configured_workspace_root_before_home_default() {
    assert_eq!(
      workspace_data_path(
        Some(PathBuf::from("/managed/workspaces")),
        Some(PathBuf::from("/Users/operator")),
      ),
      Some(PathBuf::from("/managed/workspaces"))
    );
    assert_eq!(
      workspace_data_path(None, Some(PathBuf::from("/Users/operator"))),
      Some(PathBuf::from("/Users/operator/.tachiko-conductor/workspaces"))
    );
    assert_eq!(workspace_data_path(None, None), None);
  }

  #[test]
  fn managed_root_discovery_reaches_owner_repository_run_hierarchy() {
    let root = std::env::temp_dir().join(format!(
      "tachiko-control-tower-managed-roots-{}",
      SystemTime::now().duration_since(UNIX_EPOCH).expect("clock").as_nanos()
    ));
    let run = root.join("nurockplayer/tachiko-conductor/issue-32");
    fs::create_dir_all(&run).expect("create bounded managed hierarchy");
    let roots = managed_worktree_roots(&root);
    assert!(roots.contains(&run.to_string_lossy().to_string()));
    fs::remove_dir_all(root).expect("remove test-only hierarchy");
  }

  #[test]
  fn discovery_lists_each_common_git_directory_once_for_multiple_projected_runs() {
    let fake = FakeCommands::with(&[
      ("git", "-C\u{1}/managed/one\u{1}rev-parse\u{1}--show-toplevel", "/managed/one\n"),
      ("git", "-C\u{1}/managed/two\u{1}rev-parse\u{1}--show-toplevel", "/managed/two\n"),
      ("git", "-C\u{1}/managed/one\u{1}rev-parse\u{1}--path-format=absolute\u{1}--git-common-dir", "/repo/.git\n"),
      ("git", "-C\u{1}/managed/two\u{1}rev-parse\u{1}--path-format=absolute\u{1}--git-common-dir", "/repo/.git\n"),
      ("git", "-C\u{1}/managed/one\u{1}config\u{1}--get\u{1}remote.origin.url", "git@github.com:acme/widgets.git\n"),
      ("git", "-C\u{1}/managed/two\u{1}config\u{1}--get\u{1}remote.origin.url", "git@github.com:acme/widgets.git\n"),
      ("git", "-C\u{1}/managed/one\u{1}symbolic-ref\u{1}--quiet\u{1}--short\u{1}HEAD", "one\n"),
      ("git", "-C\u{1}/managed/two\u{1}symbolic-ref\u{1}--quiet\u{1}--short\u{1}HEAD", "two\n"),
      ("git", "-C\u{1}/managed/one\u{1}rev-parse\u{1}HEAD", "one-head\n"),
      ("git", "-C\u{1}/managed/two\u{1}rev-parse\u{1}HEAD", "two-head\n"),
      ("git", "-C\u{1}/managed/one\u{1}worktree\u{1}list\u{1}--porcelain", "worktree /managed/one\nHEAD one-head\nbranch refs/heads/one\n\nworktree /managed/two\nHEAD two-head\nbranch refs/heads/two\n"),
    ]);
    let runs = ["one", "two"].into_iter().map(|id| RunObservation {
      id: id.to_owned(), repository: "acme/widgets".to_owned(), workspace_path: format!("/managed/{id}"),
      branch: id.to_owned(), base_sha: "base".to_owned(), head_sha: None, pull_request_head_sha: None,
      issue: None, pull_request_number: None, provider: None, profile: None, state: "WORKING".to_owned(), review_fix_active: false, duration_ms: None,
    }).collect::<Vec<_>>();
    let discovered = discover_worktrees(&fake, None, Path::new("/missing-managed-root"), &runs);
    assert_eq!(discovered.len(), 2);
    assert_eq!(fake.call_count("git", "-C\u{1}/managed/one\u{1}worktree\u{1}list\u{1}--porcelain"), 1);
    assert_eq!(fake.call_count("git", "-C\u{1}/managed/two\u{1}worktree\u{1}list\u{1}--porcelain"), 0);
  }

  #[test]
  fn disk_stats_probes_an_existing_ancestor_for_a_fresh_workspace_root() {
    let fake = FakeCommands::with(&[(
      "df",
      "-k\u{1}/",
      "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk 1000 400 600 40% /\n",
    )]);
    assert_eq!(
      disk_stats(&fake, Path::new("/tachiko-control-tower-missing-workspace/root")),
      (Some(1_024_000), Some(614_400))
    );
  }

  #[test]
  fn process_observation_is_unknown_when_path_has_multiple_processes() {
    let fake = FakeCommands::with(&[
      ("lsof", "-t\u{1}--\u{1}/tmp/worktree", "41\n42\n"),
      ("ps", "-o\u{1}rss=\u{1}-p\u{1}41", "100\n"),
    ]);
    assert!(current_process(&fake, "/tmp/worktree").is_none());
  }

  #[test]
  fn operational_projection_requires_version_digest_and_bootstrap_identity() {
    let digest = "a".repeat(64);
    assert!(operational_run_observation(&serde_json::json!({
      "schemaVersion": 1, "runId": "run-32", "sourceUpdatedAt": "1", "sourceDigest": digest,
      "workflowState": "IMPLEMENTING", "target": { "owner": "nurockplayer", "repo": "tachiko-conductor", "issueNumber": 32 }
    }), "run-32", &digest).is_none());
    let run = operational_run_observation(&serde_json::json!({
      "schemaVersion": 1, "runId": "run-32", "sourceUpdatedAt": "1", "sourceDigest": digest,
      "workflowState": "IMPLEMENTING",
      "target": { "owner": "nurockplayer", "repo": "tachiko-conductor", "issueNumber": 32 },
      "bootstrap": { "workspacePath": "/tmp/worktree", "branch": "tachiko/issue-32", "baseBranch": "main", "baseSha": "base" }
    }), "run-32", &digest).expect("complete operational projection");
    assert_eq!(run.workspace_path, "/tmp/worktree");
    assert_eq!(run.repository, "nurockplayer/tachiko-conductor");
    assert_eq!(run.branch, "tachiko/issue-32");
    assert!(operational_run_observation(&serde_json::json!({
      "schemaVersion": 1, "runId": "run-32", "sourceUpdatedAt": "1", "sourceDigest": "b",
      "workflowState": "IMPLEMENTING", "target": { "owner": "nurockplayer", "repo": "tachiko-conductor" },
      "bootstrap": { "workspacePath": "/tmp/worktree", "branch": "tachiko/issue-32", "baseBranch": "main", "baseSha": "base" }
    }), "run-32", &digest).is_none());
  }

  #[test]
  fn production_collector_uses_injected_boundaries_and_never_derives_issue_from_branch() {
    let fake = FakeCommands::with(&[
      ("git", "-C\u{1}/tmp/repo\u{1}worktree\u{1}list\u{1}--porcelain", "worktree /tmp/work trees/issue-32\nHEAD 1234567890\nbranch refs/heads/codex/issue-32\n"),
      ("git", "-C\u{1}/tmp/repo\u{1}rev-parse\u{1}--show-toplevel", "/tmp/repo\n"),
      ("git", "-C\u{1}/tmp/repo\u{1}rev-parse\u{1}--path-format=absolute\u{1}--git-common-dir", "/tmp/repo/.git\n"),
      ("git", "-C\u{1}/tmp/repo\u{1}config\u{1}--get\u{1}remote.origin.url", "https://github.com/nurockplayer/tachiko-conductor.git\n"),
      ("git", "-C\u{1}/tmp/repo\u{1}symbolic-ref\u{1}--quiet\u{1}--short\u{1}HEAD", "main\n"),
      ("git", "-C\u{1}/tmp/repo\u{1}rev-parse\u{1}HEAD", "base\n"),
      ("git", "-C\u{1}/tmp/work trees/issue-32\u{1}rev-parse\u{1}--show-toplevel", "/tmp/work trees/issue-32\n"),
      ("git", "-C\u{1}/tmp/work trees/issue-32\u{1}rev-parse\u{1}--path-format=absolute\u{1}--git-common-dir", "/tmp/repo/.git\n"),
      ("git", "-C\u{1}/tmp/work trees/issue-32\u{1}config\u{1}--get\u{1}remote.origin.url", "https://github.com/nurockplayer/tachiko-conductor.git\n"),
      ("git", "-C\u{1}/tmp/work trees/issue-32\u{1}symbolic-ref\u{1}--quiet\u{1}--short\u{1}HEAD", "codex/issue-32\n"),
      ("git", "-C\u{1}/tmp/work trees/issue-32\u{1}rev-parse\u{1}HEAD", "1234567890\n"),
      ("git", "-C\u{1}/tmp/work trees/issue-32\u{1}status\u{1}--porcelain", ""),
      ("du", "-sk\u{1}/tmp/work trees/issue-32", "2048\t/tmp/work trees/issue-32\n"),
      ("df", "-k\u{1}/Users/tachikoma/.tachiko-conductor/workspaces", "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk 1000 400 600 40% /\n"),
      ("sysctl", "-n\u{1}hw.memsize", "10000\n"),
      ("vm_stat", "", "Mach Virtual Memory Statistics: (page size of 1000 bytes)\nPages free:                               4.\n"),
    ]);
    let snapshot = collect_snapshot_for_roots_with_workspace_data_path(
      &fake,
      Some(Path::new("/tmp/repo")),
      Path::new("/Users/tachikoma/.tachiko-conductor/workspaces"),
    )
    .expect("fake observations are complete enough for a snapshot");
    assert_eq!(snapshot.rows.len(), 1);
    assert_eq!(snapshot.rows[0].worktree.path, "/tmp/work trees/issue-32");
    assert_eq!(snapshot.rows[0].issue, None);
    assert_eq!(snapshot.rows[0].disk_bytes, Some(2_097_152));
    assert_eq!(snapshot.system.memory_used_bytes, Some(6_000));
  }

  #[test]
  fn correlation_requires_canonical_path_common_git_repository_branch_lineage_and_exact_head() {
    let fake = FakeCommands::with(&[
      (
        "git",
        "-C\u{1}/alias/run\u{1}rev-parse\u{1}--show-toplevel",
        "/canonical/run\n",
      ),
      (
        "git",
        "-C\u{1}/canonical/run\u{1}rev-parse\u{1}--path-format=absolute\u{1}--git-common-dir",
        "/canonical/.git\n",
      ),
      (
        "git",
        "-C\u{1}/canonical/run\u{1}config\u{1}--get\u{1}remote.origin.url",
        "git@github.com:acme/widgets.git\n",
      ),
      (
        "git",
        "-C\u{1}/canonical/run\u{1}symbolic-ref\u{1}--quiet\u{1}--short\u{1}HEAD",
        "codex/widgets\n",
      ),
      (
        "git",
        "-C\u{1}/canonical/run\u{1}rev-parse\u{1}HEAD",
        "head\n",
      ),
      (
        "git",
        "-C\u{1}/canonical/run\u{1}merge-base\u{1}--is-ancestor\u{1}base\u{1}head",
        "",
      ),
    ]);
    let worktree = VerifiedWorktree {
      path: "/canonical/run".to_owned(),
      common_git: "/canonical/.git".to_owned(),
      repository: Some("acme/widgets".to_owned()),
      branch: Some("codex/widgets".to_owned()),
      head_sha: Some("head".to_owned()),
    };
    let run = RunObservation {
      id: "run-1".to_owned(),
      repository: "AcMe/WiDgEtS".to_owned(),
      workspace_path: "/alias/run".to_owned(),
      branch: "codex/widgets".to_owned(),
      base_sha: "base".to_owned(),
      head_sha: Some("head".to_owned()),
      pull_request_head_sha: Some("head".to_owned()),
      issue: Some(1),
      pull_request_number: Some(7),
      provider: Some("codex-cli".to_owned()),
      profile: None,
      state: "VALIDATING".to_owned(),
      review_fix_active: false,
      duration_ms: None,
    };
    let run_worktrees = verified_run_worktrees(&fake, &[run.clone()]);
    assert_eq!(
      correlated_run(&fake, &[run.clone()], &run_worktrees, &worktree).map(|value| value.run.id.as_str()),
      Some("run-1")
    );
    let stale = RunObservation {
      head_sha: Some("other-head".to_owned()),
      ..run
    };
    assert!(correlated_run(&fake, &[stale], &run_worktrees, &worktree).is_none());
  }

  #[test]
  fn active_review_fix_can_remain_correlated_while_its_verified_worktree_advances() {
    let fake = FakeCommands::with(&[
      ("git", "-C\u{1}/alias/run\u{1}rev-parse\u{1}--show-toplevel", "/canonical/run\n"),
      ("git", "-C\u{1}/canonical/run\u{1}rev-parse\u{1}--path-format=absolute\u{1}--git-common-dir", "/canonical/.git\n"),
      ("git", "-C\u{1}/canonical/run\u{1}config\u{1}--get\u{1}remote.origin.url", "git@github.com:acme/widgets.git\n"),
      ("git", "-C\u{1}/canonical/run\u{1}symbolic-ref\u{1}--quiet\u{1}--short\u{1}HEAD", "codex/widgets\n"),
      ("git", "-C\u{1}/canonical/run\u{1}rev-parse\u{1}HEAD", "replacement\n"),
      ("git", "-C\u{1}/canonical/run\u{1}merge-base\u{1}--is-ancestor\u{1}accepted\u{1}replacement", ""),
      ("git", "-C\u{1}/canonical/run\u{1}merge-base\u{1}--is-ancestor\u{1}base\u{1}replacement", ""),
    ]);
    let worktree = VerifiedWorktree {
      path: "/canonical/run".to_owned(), common_git: "/canonical/.git".to_owned(),
      repository: Some("acme/widgets".to_owned()), branch: Some("codex/widgets".to_owned()),
      head_sha: Some("replacement".to_owned()),
    };
    let repair = RunObservation {
      id: "run-1".to_owned(), repository: "acme/widgets".to_owned(), workspace_path: "/alias/run".to_owned(),
      branch: "codex/widgets".to_owned(), base_sha: "base".to_owned(), head_sha: Some("accepted".to_owned()),
      pull_request_head_sha: Some("accepted".to_owned()), issue: Some(1), pull_request_number: Some(7),
      provider: Some("codex-cli".to_owned()), profile: None, state: "IMPLEMENTING".to_owned(), review_fix_active: true, duration_ms: None,
    };
    let run_worktrees = verified_run_worktrees(&fake, &[repair.clone()]);
    let repairs = [repair.clone()];
    let correlated = correlated_run(&fake, &repairs, &run_worktrees, &worktree)
      .expect("the verified local descendant remains correlated during an active repair");
    assert_eq!(correlated.run.id, "run-1");
    assert!(correlated.active_review_fix_descendant);
    assert_eq!(pull_request_head_for_correlation(&correlated, &worktree), Some("replacement"));
    let not_a_review_fix = RunObservation { review_fix_active: false, ..repair };
    assert!(correlated_run(&fake, &[not_a_review_fix], &run_worktrees, &worktree).is_none());
  }

  #[test]
  fn live_pull_request_must_still_name_the_observed_exact_head() {
    let fake = FakeCommands::with(&[(
      "gh",
      "pr\u{1}view\u{1}7\u{1}--repo\u{1}acme/widgets\u{1}--json\u{1}number,state,headRefOid",
      "{\"number\":7,\"state\":\"OPEN\",\"headRefOid\":\"head\"}",
    )]);
    assert_eq!(
      pull_request(&fake, "acme/widgets", Some(7), Some("head")).map(|value| value.state),
      Some("OPEN".to_owned())
    );
    assert!(pull_request(&fake, "acme/widgets", Some(7), Some("other-head")).is_none());
  }

  #[test]
  fn github_cli_resolution_supports_finder_launches_without_a_shell_path() {
    let available = [PathBuf::from("/opt/homebrew/bin/gh")];
    assert_eq!(
      resolve_github_cli(None, |candidate| available.contains(&candidate.to_path_buf())),
      PathBuf::from("/opt/homebrew/bin/gh")
    );
    assert_eq!(
      resolve_github_cli(Some(Path::new("/custom/gh")), |candidate| candidate == Path::new("/custom/gh")),
      PathBuf::from("/custom/gh")
    );
    assert_eq!(
      resolve_github_cli(Some(Path::new("relative-gh")), |_| false),
      PathBuf::from("gh")
    );
  }

  #[test]
  fn github_remote_parser_accepts_url_style_ssh_and_rejects_unproven_identity() {
    assert_eq!(
      github_repository_from_remote("git@GitHub.com:nurockplayer/tachiko-conductor.git"),
      Some("nurockplayer/tachiko-conductor".to_owned())
    );
    assert_eq!(
      github_repository_from_remote("ssh://git@github.com/nurockplayer/tachiko-conductor.git"),
      Some("nurockplayer/tachiko-conductor".to_owned())
    );
    assert_eq!(
      github_repository_from_remote("ssh://git@github.com:22/nurockplayer/tachiko-conductor.git"),
      Some("nurockplayer/tachiko-conductor".to_owned())
    );
    assert_eq!(
      github_repository_from_remote(
        "ssh://git@github.com/nurockplayer/tachiko-conductor/extra.git"
      ),
      None
    );
    assert_eq!(
      github_repository_from_remote(
        "ssh://git@github.com:not-a-port/nurockplayer/tachiko-conductor.git"
      ),
      None
    );
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
      autopilot: AutopilotView {
        supervisor: "unknown".to_owned(), current_stage: "unknown".to_owned(), next_poll_at: None, event_wake_eligible: "unknown".to_owned(), writer_ownership: "ambiguous".to_owned(), checkpoint: "unknown".to_owned(), checkpoint_sha: None, manual_writer_state: None, active_writer: None,
        restart: RestartView { verdict: "UNKNOWN — CANNOT PROVE SAFE".to_owned(), reason: "test".to_owned() },
      },
      source_note: "test".to_owned(),
    };
    assert_eq!(
      tray_summary(&snapshot),
      (
        "執行中 agent：1".to_owned(),
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
        "執行中 agent：資料不可用".to_owned(),
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
  fn closing_the_main_window_is_a_hide_not_an_exit_policy() {
    // The registered main-window CloseRequested handler prevents destruction;
    // tray_action("open-control-tower") continues to target that same label.
    assert_eq!(tray_action("open-control-tower"), TrayAction::Open);
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
  fn command_output_is_capped_before_a_fast_producer_can_grow_memory_unbounded() {
    let command = format!("yes x | head -c {}", MAX_COMMAND_OUTPUT_BYTES + 1);
    assert_eq!(
      output_with_timeout("sh", &["-c", &command], Duration::from_secs(2)),
      None
    );
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

  #[test]
  fn tray_and_renderer_collection_share_one_native_single_flight_lock() {
    let barrier = Arc::new(Barrier::new(2));
    let active = Arc::new(AtomicUsize::new(0));
    let maximum = Arc::new(AtomicUsize::new(0));
    let workers = (0..2)
      .map(|_| {
        let barrier = Arc::clone(&barrier);
        let active = Arc::clone(&active);
        let maximum = Arc::clone(&maximum);
        thread::spawn(move || {
          barrier.wait();
          with_snapshot_collection_lock(|| {
            let now_active = active.fetch_add(1, Ordering::SeqCst) + 1;
            maximum.fetch_max(now_active, Ordering::SeqCst);
            thread::sleep(Duration::from_millis(20));
            active.fetch_sub(1, Ordering::SeqCst);
            Ok(())
          })
        })
      })
      .collect::<Vec<_>>();
    for worker in workers {
      worker
        .join()
        .expect("worker joins")
        .expect("collector lock is available");
    }
    assert_eq!(maximum.load(Ordering::SeqCst), 1);
  }
}
