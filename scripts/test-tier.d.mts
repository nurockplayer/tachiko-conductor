export const integrationTest: string;
export const smokeTiers: Map<string, { test: string; environment: string }>;
export function selectTests(tier: string | undefined, allTests: string[]): string[];
export function environmentForTier(
  tier: string | undefined,
  inherited?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv;
export function tsxInvocation(root: string): { command: string; arguments: string[] };
