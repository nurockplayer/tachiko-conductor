import { Component, useEffect, useMemo, useState, type JSX, type ReactNode } from 'react';
import { goldenFixture } from './lib/fixture';
import { formatBytes, provenanceLabel, rowsForFilter, statusLine, summarize } from './lib/dashboard';
import { collectLiveSnapshot } from './lib/tauri';
import type { AutopilotView, ControlTowerSnapshot, DashboardFilter, WorkUnitView } from '../../../src/operational/read-model.js';

const filterLabels: ReadonlyArray<readonly [DashboardFilter, string]> = [
  ['all', '全部'],
  ['active', '執行中 agent'],
  ['reclaimable', '可回收'],
];

function isTauriRuntime(): boolean {
  return '__TAURI_INTERNALS__' in window;
}

function initialSnapshot(): ControlTowerSnapshot {
  // The fixture is visual-review data only. A production collector must show
  // an honest empty/unavailable live state rather than silently falling back.
  return isTauriRuntime()
    ? { mode: 'live', generatedAt: '', rows: [], system: {}, sourceNote: '正在讀取即時 operational observations。' }
    : goldenFixture;
}

function duration(value?: number): string {
  if (value === undefined) return '';
  return `${Math.max(1, Math.round(value / 60_000))}m`;
}

function stateLabel(row: WorkUnitView): string {
  if (row.reclaim.state === 'reclaimable') return '✓ 可安全回收';
  if (row.reclaim.state === 'in_use') return '使用中';
  if (row.reclaim.state === 'blocked') return 'blocked';
  return 'unknown';
}

function countdown(nextPollAt?: string): string {
  if (!nextPollAt) return '排程未知';
  const milliseconds = Date.parse(nextPollAt) - Date.now();
  if (!Number.isFinite(milliseconds)) return '排程未知';
  const seconds = Math.max(0, Math.ceil(milliseconds / 1_000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function phaseZero(snapshot: ControlTowerSnapshot): AutopilotView {
  return snapshot.autopilot ?? { supervisor: 'unknown', currentStage: 'unknown', eventWakeEligible: 'unknown', writerOwnership: 'ambiguous', checkpoint: 'unknown', restart: { verdict: 'UNKNOWN — CANNOT PROVE SAFE', reason: 'No typed supervisor/checkpoint projection is available.' } };
}

function writerSummary(autopilot: AutopilotView): { title: string; detail: string } {
  if (autopilot.writerOwnership === 'none') {
    const checkpoint = autopilot.checkpoint === 'durable'
      ? `Durable checkpoint${autopilot.checkpointSha ? ` · ${autopilot.checkpointSha.slice(0, 12)}` : ''}`
      : 'Checkpoint is not durable';
    return { title: 'none active', detail: `${checkpoint}${autopilot.manualWriterState ? ` · manual writer ${autopilot.manualWriterState}` : ''}` };
  }
  if (autopilot.writerOwnership === 'active') {
    return { title: autopilot.activeWriter ? `#${autopilot.activeWriter.issue ?? '—'} · ${autopilot.activeWriter.worker ?? 'manual'}` : 'active', detail: autopilot.activeWriter?.runId ? `Run ${autopilot.activeWriter.runId}` : 'Typed writer ownership is active' };
  }
  return { title: 'unknown', detail: 'No typed ownership proof available' };
}

export function ControlTower(): JSX.Element {
  return <DashboardBoundary><ControlTowerBody /></DashboardBoundary>;
}

function ControlTowerBody(): JSX.Element {
  const [filter, setFilter] = useState<DashboardFilter>('all');
  const [snapshot, setSnapshot] = useState<ControlTowerSnapshot>(initialSnapshot);
  const [liveError, setLiveError] = useState<string | null>(null);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let disposed = false;
    let timer: number | undefined;
    const refresh = async (): Promise<void> => {
      try {
        const next = await collectLiveSnapshot();
        if (!disposed) {
          setSnapshot(next);
          setLiveError(null);
        }
      } catch (error: unknown) {
        if (!disposed) setLiveError(error instanceof Error ? error.message : String(error));
      } finally {
        // Schedule only after the prior collection settles: native reads can
        // take longer than the cadence and must never overlap or reorder.
        if (!disposed) timer = window.setTimeout(() => { void refresh(); }, 15_000);
      }
    };
    void refresh();
    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, []);

  const rows = useMemo(() => rowsForFilter(snapshot.rows, filter), [snapshot.rows, filter]);
  const summary = useMemo(() => summarize(snapshot), [snapshot]);
  const memoryText = formatBytes(summary.memoryUsedBytes);
  const autopilot = phaseZero(snapshot);
  const writer = writerSummary(autopilot);

  return <main className="tower-shell">
    <header className="tower-header">
      <div>
        <h1>執行中工作總覽</h1>
        <p>{provenanceLabel(snapshot.mode)}</p>
      </div>
      <div className="filters" aria-label="工作篩選">
        {filterLabels.map(([value, label]) => <button key={value} type="button" className={filter === value ? (value === 'reclaimable' ? 'selected accent' : 'selected') : ''} onClick={() => setFilter(value)}>{label}</button>)}
      </div>
    </header>

    <section className="autopilot-card" aria-label="Autopilot 狀態">
      <div className="autopilot-heading"><div><h2>Autopilot / Dispatch</h2><p>Typed operational state · raw logs are diagnostics only</p></div><span className={`verdict ${autopilot.restart.verdict.startsWith('SAFE') ? 'safe' : 'caution'}`}>{autopilot.restart.verdict}</span></div>
      <div className="autopilot-grid">
        <div><span>Supervisor</span><strong>{autopilot.supervisor}</strong><small>Current stage · {autopilot.currentStage}</small></div>
        <div><span>Repository writer</span><strong>{writer.title}</strong><small>{writer.detail}</small></div>
        <div><span>Next scheduled poll</span><strong>{autopilot.nextPollAt ? countdown(autopilot.nextPollAt) : 'unknown'}</strong><small>{autopilot.nextPollAt ?? 'Not deterministically known'}</small></div>
        <div><span>Earlier event wake</span><strong>{autopilot.eventWakeEligible === 'yes' ? 'possible' : autopilot.eventWakeEligible}</strong><small>{autopilot.eventWakeEligible === 'yes' ? 'Poll countdown is not a guaranteed window' : 'No earlier wake proven'}</small></div>
      </div>
      <p className="restart-reason">{autopilot.restart.reason}</p>
      {autopilot.lastMeaningfulTransition ? <p className="transition">Last meaningful transition · {autopilot.lastMeaningfulTransition}</p> : null}
      <details className="diagnostics"><summary>Diagnostics / raw evidence</summary><p>Heartbeat, wake, and worker logs are available for diagnosis only; they do not determine workflow ownership or restart safety.</p></details>
    </section>

    <section className="summary-grid" aria-label="系統摘要">
      <SummaryCard label="執行中 agent" value={String(summary.activeCount)} detail={`${summary.activeWorktrees} 個 worktree`} />
      <SummaryCard label="記憶體" value={memoryText} detail={summary.memoryPercent === undefined ? '使用量未知' : `${summary.memoryPercent}% 使用`} progress={summary.memoryPercent} />
      <SummaryCard label="Data 磁碟" value={formatBytes(summary.diskFreeBytes)} detail={summary.diskPercentUsed === undefined ? '剩餘容量未知' : `${summary.diskPercentUsed}% · 剩餘容量`} progress={summary.diskPercentUsed} />
      <SummaryCard label="可立即回收" value={formatBytes(summary.reclaimBytes)} detail={`${summary.reclaimCount} 個 worktree`} />
    </section>

    <section className="table-card" aria-label="工作清單">
      <div className="table-scroll"><table>
        <thead><tr><th>Issue / Repo</th><th>Codex</th><th>PR</th><th>Worktree</th><th>RAM</th><th>Disk</th><th>回收狀態</th></tr></thead>
        <tbody>{rows.map((row) => <tr key={`${row.repository}:${row.worktree.path}`}>
          <td><strong>{row.issue === undefined ? '—' : `#${row.issue}`}</strong><small>{row.repository}</small></td>
          <td><strong className={!row.agent || row.agent.provider === 'idle' ? 'muted' : ''}>{!row.agent ? 'unknown' : row.agent.provider === 'idle' ? 'idle' : `● ${row.agent.provider}`}</strong><small>{row.agent ? `${row.agent.state}${row.agent.durationMs ? ` · ${duration(row.agent.durationMs)}` : ''}` : 'unlinked'}</small></td>
          <td>{row.pullRequest ? <><strong>#{row.pullRequest.number}</strong><small className={row.pullRequest.state === 'MERGED' ? 'strong' : ''}>{row.pullRequest.state}</small></> : <span className="muted">unknown</span>}</td>
          <td><code>{row.worktree.shortId}</code><small title={row.worktree.path}>{row.worktree.branch ?? row.worktree.path}</small></td>
          <td>{formatBytes(row.process?.rssBytes)}</td><td><strong>{formatBytes(row.diskBytes)}</strong></td>
          <td><span className={`pill ${row.reclaim.state}`}>{stateLabel(row)}</span><small className="row-reason">{row.reclaim.reason ?? ''}</small></td>
        </tr>)}</tbody>
      </table></div>
    </section>

    <section className="bottom-grid">
      <article className="info-card"><h2>回收判定</h2><div className="checklist"><div>✓ PR 已 merged</div><div>✓ 沒有 Codex / shell process 使用 worktree</div><div>✓ Git working tree clean</div><div>✓ HEAD 已存在 remote / merged history</div><div>✓ 沒有 lock 或尚未保存的 agent state</div></div></article>
      <article className="info-card"><h2>下一步自動化</h2><p>PR merge 後先標成「可回收」。安全 mutation 尚不可用時，保留觀測與原因，不在此 UI 或 Tauri 層直接刪除 worktree。</p><button className="reclaim-action" disabled title="等待 Issue #25 的共享 housekeeping capability 與 #20 validation seam 接受/合併。">回收工作tree（尚不可用）</button></article>
    </section>
    <p className="status-line">{statusLine(filter, rows.length)}{snapshot.mode === 'live' ? ' · live observations' : ''}</p>
    {snapshot.sourceNote ? <p className="source-note">{snapshot.sourceNote}</p> : null}
    {liveError ? <p className="source-note error">live collector unavailable: {liveError}</p> : null}
  </main>;
}

class DashboardBoundary extends Component<{ readonly children: ReactNode }, { readonly failed: boolean; readonly message: string }> {
  state = { failed: false, message: '' };

  static getDerivedStateFromError(): { readonly failed: boolean; readonly message: string } {
    return { failed: true, message: '' };
  }

  componentDidCatch(error: Error): void {
    this.setState({ message: error.message });
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return <main className="tower-shell"><h1>執行中工作總覽</h1><p className="source-note error">live collector 的資料未通過 renderer 邊界；未顯示 fixture 或推定任何 live 狀態。{this.state.message ? ` ${this.state.message}` : ''}</p></main>;
  }
}

function SummaryCard({ label, value, detail, progress }: { readonly label: string; readonly value: string; readonly detail: string; readonly progress?: number }): JSX.Element {
  return <article className="summary-card"><div className="label">{label}</div><div className="summary-value">{value}</div>{progress === undefined ? null : <div className="progress"><span style={{ width: `${Math.min(100, Math.max(0, progress))}%` }} /></div>}<div className="detail">{detail}</div></article>;
}
