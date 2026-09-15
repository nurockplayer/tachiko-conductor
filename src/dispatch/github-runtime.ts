import type { GitHubWriteTransport } from '../github/transport.js';
import type { DispatchRuntimeComment } from './queue.js';
import type { DispatchRuntimeApi } from './runner.js';

export interface DispatchControlLocation {
  readonly owner: string;
  readonly repo: string;
  readonly controlIssue: number;
  readonly queueCommentId: number;
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`GitHub returned an invalid ${path} comment.`);
  return value as Record<string, unknown>;
}

function comment(value: unknown, path: string): DispatchRuntimeComment {
  const parsed = object(value, path);
  if ((typeof parsed.id !== 'number' && typeof parsed.id !== 'string') || typeof parsed.body !== 'string') {
    throw new Error(`GitHub returned an invalid ${path} comment.`);
  }
  return { id: String(parsed.id), body: parsed.body };
}

/** GitHub REST adapter whose only write capability is the dispatcher runtime comment. */
export class GitHubDispatchRuntime implements DispatchRuntimeApi {
  private readonly transport: GitHubWriteTransport;
  private readonly location: DispatchControlLocation;

  constructor(transport: GitHubWriteTransport, location: DispatchControlLocation) {
    this.transport = transport;
    this.location = location;
  }

  async readQueueComment(): Promise<string> {
    const path = `repos/${this.location.owner}/${this.location.repo}/issues/comments/${this.location.queueCommentId}`;
    return comment(await this.transport.get(path), path).body;
  }

  async listRuntimeComments(): Promise<readonly DispatchRuntimeComment[]> {
    const path = `repos/${this.location.owner}/${this.location.repo}/issues/${this.location.controlIssue}/comments`;
    return (await this.transport.getPaginated(path)).map((value) => comment(value, path));
  }

  async createRuntimeComment(body: string): Promise<DispatchRuntimeComment> {
    const path = `repos/${this.location.owner}/${this.location.repo}/issues/${this.location.controlIssue}/comments`;
    return comment(await this.transport.write(path, 'POST', { body }), path);
  }

  async updateRuntimeComment(id: string, body: string): Promise<DispatchRuntimeComment> {
    if (!/^\d+$/.test(id)) throw new Error('GitHub runtime comment id must be a decimal integer.');
    const path = `repos/${this.location.owner}/${this.location.repo}/issues/comments/${id}`;
    return comment(await this.transport.write(path, 'PATCH', { body }), path);
  }
}
