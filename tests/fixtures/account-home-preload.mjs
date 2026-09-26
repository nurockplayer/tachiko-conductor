import os from 'node:os';

// Test-owned account lookup shim for subprocess fixtures. Production code never
// reads this test convention; HOME variants stay isolated below each fixture.
const fixtureHome = process.env.HOME;
if (fixtureHome) {
  const userInfo = os.userInfo;
  os.userInfo = (...args) => ({ ...userInfo(...args), homedir: fixtureHome });
}
