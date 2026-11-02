export interface ActivitySnapshot {
  label: string | null;
  detail: string | null;
  updated_at: number | null;
}

export class ActivityTracker {
  static STALE_SEC = 30;

  private label: string | null = null;
  private detail: string | null = null;
  private updatedAt = 0;
  private depth = 0;

  snapshot(): ActivitySnapshot {
    const now = performance.now() / 1000;
    if (this.depth <= 0 || now - this.updatedAt > ActivityTracker.STALE_SEC) {
      return { label: null, detail: null, updated_at: null };
    }
    return { label: this.label, detail: this.detail, updated_at: this.updatedAt };
  }

  async track<T>(label: string, detail: string | null, fn: () => Promise<T>): Promise<T> {
    this.depth += 1;
    this.label = label;
    this.detail = detail;
    this.updatedAt = performance.now() / 1000;
    try {
      return await fn();
    } finally {
      this.depth -= 1;
      if (this.depth <= 0) {
        this.depth = 0;
        this.label = null;
        this.detail = null;
      }
    }
  }
}
