/** Use the exact tag Ollama registered (e.g. ...:latest) to avoid resolution quirks. */
export function resolveInstalledModel(requested: string, installed: string[]): string {
  if (installed.includes(requested)) return requested;
  const withLatest = `${requested}:latest`;
  if (installed.includes(withLatest)) return withLatest;
  const bare = requested.split(':')[0];
  const matches = installed.filter((n) => n.split(':')[0] === bare);
  if (matches.length === 0) return requested;
  return matches.find((n) => n.endsWith(':latest')) ?? matches[0];
}

export function nsToSec(n?: number): number {
  return (n ?? 0) / 1e9;
}

export function decodeTokPerSec(evalCount: number, evalDurationNs?: number): number {
  const sec = nsToSec(evalDurationNs);
  if (evalCount <= 0 || sec <= 0) return 0;
  return evalCount / sec;
}
