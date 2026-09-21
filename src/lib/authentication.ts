export function isTunnelAuthentication(status: number, challenge: string | null): boolean {
  return status === 401 && /(?:^|,)\s*tunnel(?:\s|,|$)/i.test(challenge ?? "");
}
