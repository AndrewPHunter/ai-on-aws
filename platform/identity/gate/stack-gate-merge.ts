// Adds the one statement the stack gate cannot check from inside the network: that the client wrote no
// revocation failure to its output during the gate's run. platform/identity/stack-gate.sh reads the
// client's output on the Docker host and passes only what it found, as REVOCATION_FAILURES: a count of
// failure lines, or "unreadable" when the output could not be read.
//
// Usage: node stack-gate-merge.ts < report.json
// Writes the completed report to standard output. Exit codes: 0 every statement holds, 1 one does not,
// 2 could not run.

const STATEMENT = "the client's output shows no failure to revoke a refresh token during this run";

async function main(): Promise<number> {
  const found = process.env['REVOCATION_FAILURES'];
  if (found === undefined || found === '') throw new Error('REVOCATION_FAILURES is not set');
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    if (Buffer.isBuffer(chunk)) chunks.push(chunk);
  }
  // not_checked: the statements the stack could not show, each with why. Kept as it is: neither held nor failed.
  const report = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { passed: boolean; failed: string[]; not_checked: string[]; held: string[] };
  if (!Array.isArray(report.failed) || !Array.isArray(report.not_checked) || !Array.isArray(report.held)) {
    throw new Error('the report has no held, failed or not_checked list');
  }
  if (found === '0') {
    report.held.push(STATEMENT);
  } else if (found === 'unreadable') {
    report.failed.push(`${STATEMENT}: not checked, the client's output could not be read`);
  } else {
    report.failed.push(`${STATEMENT}: ${found} failure line(s)`);
  }
  report.passed = report.failed.length === 0;
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report.passed ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`stack-gate: could not merge the report: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  },
);
