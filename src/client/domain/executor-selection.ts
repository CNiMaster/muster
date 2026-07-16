export function selectPreferredExecutor<T extends { connection?: { status?: string } | null }>(profiles: T[]): T | undefined {
  return profiles.find((profile) => profile.connection?.status === 'connected') ?? profiles[0];
}
