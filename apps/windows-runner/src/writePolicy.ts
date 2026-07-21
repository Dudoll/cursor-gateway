import type { RunnerJob } from "@cursor-gateway/shared";

type WritePolicyInput = Pick<RunnerJob, "allowWrites" | "sshWriteHosts">;

export function buildWritePolicy(job: WritePolicyInput): string {
  if (!job.allowWrites) {
    return "Do not modify files. You may inspect and explain only.";
  }

  const localPolicy =
    "You may read and write any path on this machine that the OS user can access.";
  const sshPolicy =
    "You may use SSH-family tools to connect to external hosts and read or write remote paths as authorized by SSH credentials.";
  const hosts = [...new Set(job.sshWriteHosts)];
  if (hosts.length === 0) {
    return `${localPolicy} ${sshPolicy}`;
  }

  return [
    localPolicy,
    sshPolicy,
    `Preconfigured SSH aliases (prefer these when applicable): ${hosts.join(", ")}.`
  ].join(" ");
}
