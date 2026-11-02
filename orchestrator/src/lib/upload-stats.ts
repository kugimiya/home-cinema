export function accumulateUpload(
  lifetimeBytes: number,
  lastReportedBytes: number,
  reportedBytes: number,
): [number, number] {
  const reported = Math.max(0, Math.trunc(reportedBytes));
  let lifetime = Math.max(0, Math.trunc(lifetimeBytes));
  const last = Math.max(0, Math.trunc(lastReportedBytes));
  if (reported >= last) {
    lifetime += reported - last;
  } else {
    lifetime += reported;
  }
  return [lifetime, reported];
}
