import type {
  AgentHandoffSnapshot,
  GitHubConversationEntry,
  GitHubProblem,
} from '../adapters/github.js';

const HANDOFF_MARKER = '<!-- agent-handoff:v1 -->';
const FULL_SHA_PATTERN = /\b[0-9a-f]{40}\b/gi;

export interface HandoffLiveIdentity {
  readonly headSha: string | null;
  readonly pullRequestNumber: number | null;
}

export interface ParsedAgentHandoffs {
  readonly handoff: AgentHandoffSnapshot | null;
  readonly problems: readonly GitHubProblem[];
}

interface Candidate {
  entry: GitHubConversationEntry;
  sections: Readonly<Record<string, string>>;
  claimedHeadSha?: string;
  claimedPullRequestNumber?: number;
}

function countMarker(body: string): number {
  return body.split(HANDOFF_MARKER).length - 1;
}

function parseSections(body: string): Readonly<Record<string, string>> {
  const headings = [...body.matchAll(/^##\s+(.+?)\s*$/gm)];
  const sections: Record<string, string> = {};
  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index];
    if (heading === undefined) continue;
    const name = heading[1]?.trim();
    if (name === undefined || name === '') continue;
    const start = (heading.index ?? 0) + heading[0].length;
    const end = headings[index + 1]?.index ?? body.length;
    sections[name] = body.slice(start, end).trim();
  }
  return sections;
}

function identitySectionText(sections: Readonly<Record<string, string>>): string {
  return Object.entries(sections)
    .filter(([heading]) => /(?:current\s+state|branch|\bpr\b)/i.test(heading))
    .map(([, value]) => value)
    .join('\n');
}

function uniqueMatch<T>(values: readonly T[]): T | undefined {
  const unique = [...new Set(values)];
  return unique.length === 1 ? unique[0] : undefined;
}

function extractClaims(sections: Readonly<Record<string, string>>): {
  ambiguous: boolean;
  claimedHeadSha?: string;
  claimedPullRequestNumber?: number;
} {
  const identityText = identitySectionText(sections);
  const headClaims = [...new Set((identityText.match(FULL_SHA_PATTERN) ?? []).map((sha) => sha.toLowerCase()))];
  const prNumbers = [
    ...[...identityText.matchAll(/\bPR\s*:\s*#?(\d+)\b/gi)].map((match) => Number(match[1])),
    ...[...identityText.matchAll(/\/pull\/(\d+)\b/gi)].map((match) => Number(match[1])),
  ].filter((number) => Number.isSafeInteger(number) && number > 0);
  const uniquePrNumbers = [...new Set(prNumbers)];
  const claimedHeadSha = uniqueMatch(headClaims);
  const claimedPullRequestNumber = uniqueMatch(uniquePrNumbers);
  return {
    ambiguous: headClaims.length > 1 || uniquePrNumbers.length > 1,
    ...(claimedHeadSha === undefined ? {} : { claimedHeadSha }),
    ...(claimedPullRequestNumber === undefined ? {} : { claimedPullRequestNumber }),
  };
}

function compareEntries(a: GitHubConversationEntry, b: GitHubConversationEntry): number {
  const byTime = a.updatedAt.localeCompare(b.updatedAt);
  return byTime !== 0 ? byTime : a.id.localeCompare(b.id);
}

function malformedProblem(entry: GitHubConversationEntry): GitHubProblem {
  return {
    code: 'MALFORMED_HANDOFF',
    message: `Comment ${entry.id} contains an agent-handoff marker but no non-empty level-two sections.`,
    sourceId: entry.id,
  };
}

/** Parse all handoff markers without allowing them to override GitHub live identity. */
export function parseAgentHandoffs(
  entries: readonly GitHubConversationEntry[],
  live: HandoffLiveIdentity,
): ParsedAgentHandoffs {
  const problems: GitHubProblem[] = [];
  const valid: Candidate[] = [];
  const malformed: GitHubConversationEntry[] = [];

  for (const entry of entries) {
    const markers = countMarker(entry.body);
    if (markers === 0) continue;
    if (markers > 1) {
      problems.push({
        code: 'AMBIGUOUS_HANDOFF',
        message: `Comment ${entry.id} contains ${markers} agent-handoff markers; refusing to splice them.`,
        sourceId: entry.id,
      });
      continue;
    }
    const markedBody = entry.body.slice(entry.body.indexOf(HANDOFF_MARKER) + HANDOFF_MARKER.length);
    const headings = [...markedBody.matchAll(/^##\s+(.+?)\s*$/gm)].map((match) => match[1]?.trim().toLowerCase()).filter((name): name is string => name !== undefined);
    if (new Set(headings).size !== headings.length) {
      problems.push({
        code: 'AMBIGUOUS_HANDOFF',
        message: `Comment ${entry.id} contains duplicate level-two handoff sections; refusing to overwrite authority sections.`,
        sourceId: entry.id,
      });
      continue;
    }
    const sections = parseSections(markedBody);
    if (Object.keys(sections).length === 0 || Object.values(sections).every((value) => value === '')) {
      malformed.push(entry);
      problems.push(malformedProblem(entry));
      continue;
    }
    const claims = extractClaims(sections);
    if (claims.ambiguous) {
      problems.push({
        code: 'AMBIGUOUS_HANDOFF',
        message: `Comment ${entry.id} contains conflicting branch or pull request identity claims.`,
        sourceId: entry.id,
      });
      continue;
    }
    const { ambiguous: _ambiguous, ...identity } = claims;
    valid.push({ entry, sections, ...identity });
  }

  valid.sort((a, b) => compareEntries(a.entry, b.entry));
  const selected = valid.at(-1);
  if (selected === undefined) return { handoff: null, problems };

  if (valid.length > 1) {
    problems.push({
      code: 'DUPLICATE_HANDOFFS',
      message: `Found ${valid.length} valid agent handoff comments; selected the latest by updatedAt and id.`,
      details: { sourceIds: valid.map((candidate) => candidate.entry.id) },
    });
  }
  for (const entry of malformed.sort(compareEntries)) {
    if (compareEntries(entry, selected.entry) > 0) {
      problems.push({
        code: 'MALFORMED_HANDOFF_NEWER_THAN_SELECTED',
        message: `Malformed handoff comment ${entry.id} is newer than selected valid handoff ${selected.entry.id}.`,
        sourceId: entry.id,
      });
    }
  }

  const stale =
    (selected.claimedHeadSha !== undefined && selected.claimedHeadSha !== live.headSha?.toLowerCase()) ||
    (selected.claimedPullRequestNumber !== undefined && selected.claimedPullRequestNumber !== live.pullRequestNumber);
  const hasClaim = selected.claimedHeadSha !== undefined || selected.claimedPullRequestNumber !== undefined;
  const freshness: AgentHandoffSnapshot['freshness'] = stale ? 'stale' : hasClaim ? 'current' : 'unknown';
  if (stale) {
    problems.push({
      code: 'STALE_HANDOFF',
      message: `Handoff ${selected.entry.id} does not match the selected live pull request identity.`,
      sourceId: selected.entry.id,
      details: {
        claimedHeadSha: selected.claimedHeadSha,
        liveHeadSha: live.headSha,
        claimedPullRequestNumber: selected.claimedPullRequestNumber,
        livePullRequestNumber: live.pullRequestNumber,
      },
    });
  }

  return {
    handoff: {
      sourceId: selected.entry.id,
      sourceScope: selected.entry.scope,
      sourceUpdatedAt: selected.entry.updatedAt,
      sections: selected.sections,
      ...(selected.claimedHeadSha === undefined ? {} : { claimedHeadSha: selected.claimedHeadSha }),
      ...(selected.claimedPullRequestNumber === undefined
        ? {}
        : { claimedPullRequestNumber: selected.claimedPullRequestNumber }),
      freshness,
    },
    problems,
  };
}
