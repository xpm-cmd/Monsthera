export interface NonceStoreResult {
  accepted: boolean;
  reason: "accepted" | "replayed";
}

type NowFn = () => number;

export class CrossInstanceNonceStore {
  private readonly seen = new Map<string, Map<string, number>>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: NowFn = () => Date.now(),
  ) {}

  checkAndStore(instanceId: string, nonce: string, observedAt = this.now()): NonceStoreResult {
    this.purgeExpired(observedAt);

    const normalizedInstanceId = instanceId.trim();
    const normalizedNonce = nonce.trim();
    const peerNonces = this.seen.get(normalizedInstanceId) ?? new Map<string, number>();

    if (peerNonces.has(normalizedNonce)) {
      return { accepted: false, reason: "replayed" };
    }

    peerNonces.set(normalizedNonce, observedAt + this.ttlMs);
    this.seen.set(normalizedInstanceId, peerNonces);
    return { accepted: true, reason: "accepted" };
  }

  has(instanceId: string, nonce: string, observedAt = this.now()): boolean {
    this.purgeExpired(observedAt);
    return this.seen.get(instanceId.trim())?.has(nonce.trim()) ?? false;
  }

  purgeExpired(observedAt = this.now()): void {
    for (const [instanceId, peerNonces] of this.seen) {
      for (const [nonce, expiresAt] of peerNonces) {
        if (expiresAt <= observedAt) {
          peerNonces.delete(nonce);
        }
      }
      if (peerNonces.size === 0) {
        this.seen.delete(instanceId);
      }
    }
  }

  size(): number {
    let total = 0;
    for (const peerNonces of this.seen.values()) {
      total += peerNonces.size;
    }
    return total;
  }
}
