// Translate a Windows drive path (e.g. "D:\\cursor-vps") into the local
// filesystem path used by the current runtime. On Windows this is a no-op. On
// Linux (e.g. a WSL runner sharing a workspace registered with a Windows path)
// it maps "X:\\rest" to "/mnt/x/rest" so a runner can operate on the same
// workspace the Windows runner registered. Non-Windows-style paths are returned
// unchanged, so native Linux workspaces are unaffected.
export function toLocalPath(inputPath: string): string {
  if (process.platform !== "linux") return inputPath;

  const match = /^([A-Za-z]):[\\/](.*)$/.exec(inputPath);
  if (!match) return inputPath;

  const [, driveLetter = "", rawRest = ""] = match;
  const drive = driveLetter.toLowerCase();
  const rest = rawRest.replace(/\\/g, "/");
  return `/mnt/${drive}/${rest}`;
}
