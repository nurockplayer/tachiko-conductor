import { readSync } from 'node:fs';

import { HEARTBEAT_ADMISSION_REQUEST_MAX_BYTES, handleHeartbeatAdmissionJson } from './heartbeat-admission.js';

const chunks: Buffer[] = [];
const chunk = Buffer.alloc(4_096);
let total = 0;
for (;;) {
  const count = readSync(0, chunk, 0, Math.min(chunk.length, HEARTBEAT_ADMISSION_REQUEST_MAX_BYTES + 1 - total), null);
  if (count === 0) break;
  total += count;
  if (total > HEARTBEAT_ADMISSION_REQUEST_MAX_BYTES) {
    console.log(JSON.stringify({ schemaVersion: 1, outcome: 'error', code: 'request_too_large' }));
    process.exitCode = 1;
    break;
  }
  chunks.push(Buffer.from(chunk.subarray(0, count)));
}

if (total <= HEARTBEAT_ADMISSION_REQUEST_MAX_BYTES) {
  try {
    const output = handleHeartbeatAdmissionJson(Buffer.concat(chunks).toString('utf8'));
    console.log(output);
  } catch {
    // Do not copy exception text to stdout: path, receipt, or capability details
    // are never part of the helper's ordinary machine-readable response.
    console.log(JSON.stringify({ schemaVersion: 1, outcome: 'error', code: 'admission_unavailable' }));
    process.exitCode = 1;
  }
}
