import { Component, useEffect, useMemo, useState, type JSX, type ReactNode } from 'react';
import { goldenFixture } from './lib/fixture';
import { rowsForFilter, statusLine, summarize } from './lib/dashboard';
import { collectLiveSnapshot } from './lib/tauri';
import type { ControlTowerSnapshot, DashboardFilter, WorkUnitView } from '../../../src/operational/read-model.js';

const filterLabels: ReadonlyArray<readonly [DashboardFilter, string]> = [
  ['all', '全部'],
  ['active', 'Codex 執行中'],
  ['reclaimable', '可回收'],
];

function bytes(value?: number): string {
  if (value === undefined || value <= 0) return '—';
  if (value < 1_000_000_000) return `${(value / 1_000_000).toFixed(1)} MB`;
  return `${(value / 1_000_000_000).toFixed(1)} GB`;
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

export function ControlTower(): JSX.Element {
  return <DashboardBoundary><ControlTowerBody /></DashboardBoundary>;
}

function ControlTowerBody(): JSX.Element {
  const [filter, setFilter] = useState<DashboardFilter>('all');
  const [snapshot, setSnapshot] = useState<ControlTowerSnapshot>(goldenFixture);
  const [liveError, setLiveError] = useState<string | null>(null);

  useEffect(() => {
    if (!('__TAURI_INTERNALS__' in window)) return;
    let disposed = false;
    const refresh = (): void => {
      void collectLiveSnapshot()
        .then((next) => {
          if (!disposed) {
            setSnapshot(next);
            setLiveError(null);
          }
        })
        .catch((error: unknown) => {
          if (!disposed) setLiveError(error instanceof Error ? error.message : String(error));
        });
    };
    refresh();
    const interval = window.setInterval(refresh, 15_000);
    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, []);

  const rows = useMemo(() => rowsForFilter(snapshot.rows, filter), [snapshot.rows, filter]);
  const summary = useMemo(() => summarize(snapshot), [snapshot]);
  const memoryText = bytes(summary.memoryUsedBytes);

  return <main className="tower-shell">
    <header className="tower-header">
      <div>
        <h1>執行中工作總覽</h1>
        <p>示意資料 · Issue → Codex → PR → Worktree → 回收</p>
      </div>
      <div className="filters" aria-label="工作篩選">
        {filterLabels.map(([value, label]) => <button key={value} type="button" className={filter === value ? (value === 'reclaimable' ? 'selected accent' : 'selected') : ''} onClick={() => setFilter(value)}>{label}</button>)}
      </div>
    </header>

    <section className="summary-grid" aria-label="系統摘要">
      <SummaryCard label="Codex 執行中" value={String(summary.activeCount)} detail={`${summary.activeWorktrees} 個 worktree`} />
      <SummaryCard label="記憶體" value={memoryText} detail={summary.memoryPercent === undefined ? '使用量未知' : `${summary.memoryPercent}% 使用`} progress={summary.memoryPercent} />
      <SummaryCard label="Data 磁碟" value={bytes(summary.diskFreeBytes)} detail={summary.diskPercentUsed === undefined ? '剩餘容量未知' : `${summary.diskPercentUsed}% · 剩餘容量`} progress={summary.diskPercentUsed} />
      <SummaryCard label="可立即回收" value={bytes(summary.reclaimBytes)} detail={`${summary.reclaimCount} 個 worktree`} />
    </section>

    <section className="table-card" aria-label="工作清單">
      <div className="table-scroll"><table>
        <thead><tr><th>Issue / Repo</th><th>Codex</th><th>PR</th><th>Worktree</th><th>RAM</th><th>Disk</th><th>回收狀態</th></tr></thead>
        <tbody>{rows.map((row) => <tr key={`${row.repository}:${row.worktree.path}`}>
          <td><strong>{row.issue === undefined ? '—' : `#${row.issue}`}</strong><small>{row.repository}</small></td>
          <td><strong className={!row.agent || row.agent.provider === 'idle' ? 'muted' : ''}>{!row.agent ? 'unknown' : row.agent.provider === 'idle' ? 'idle' : `● ${row.agent.provider}`}</strong><small>{row.agent ? `${row.agent.state}${row.agent.durationMs ? ` · ${duration(row.agent.durationMs)}` : ''}` : 'unlinked'}</small></td>
          <td>{row.pullRequest ? <><strong>#{row.pullRequest.number}</strong><small className={row.pullRequest.state === 'MERGED' ? 'strong' : ''}>{row.pullRequest.state}</small></> : <span className="muted">unknown</span>}</td>
          <td><code>{row.worktree.shortId}</code><small title={row.worktree.path}>{row.worktree.branch ?? row.worktree.path}</small></td>
          <td>{bytes(row.process?.rssBytes)}</td><td><strong>{bytes(row.diskBytes)}</strong></td>
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
    return <main className="tower-shell"><h1>執行中工作總覽</h1><p className="source-note error">live collector 的資料未通過 renderer 邊界；已保留 golden fixture，未推定任何 live 狀態。{this.state.message ? ` ${this.state.message}` : ''}</p></main>;
  }
}

function SummaryCard({ label, value, detail, progress }: { readonly label: string; readonly value: string; readonly detail: string; readonly progress?: number }): JSX.Element {
  return <article className="summary-card"><div className="label">{label}</div><div className="summary-value">{value}</div>{progress === undefined ? null : <div className="progress"><span style={{ width: `${Math.min(100, Math.max(0, progress))}%` }} /></div>}<div className="detail">{detail}</div></article>;
}
