/**
 * Minimal circuit breaker for outbound supplier calls.
 *
 * Why: if a wholesaler API is down, every checkout would otherwise wait the full
 * timeout (8 s) before failing, tying up connections and making the whole site feel
 * broken. After `failureThreshold` consecutive failures we "open" the circuit and fail
 * instantly for `cooldownMs`, then let a single trial request through (half-open).
 */
export class CircuitOpenError extends Error {
  constructor(readonly name_: string, readonly retryAfterMs: number) {
    super(`circuit "${name_}" is open`);
    this.name = 'CircuitOpenError';
  }
}

type State = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export class CircuitBreaker {
  private state: State = 'CLOSED';
  private failures = 0;
  private openedAt = 0;
  private trialInFlight = false;

  constructor(
    readonly name: string,
    private readonly failureThreshold = 5,
    private readonly cooldownMs = 30_000,
  ) {}

  get currentState(): State {
    return this.state;
  }

  async exec<T>(fn: () => Promise<T>, isFailure: (err: unknown) => boolean = () => true): Promise<T> {
    if (this.state === 'OPEN') {
      const waited = Date.now() - this.openedAt;
      if (waited < this.cooldownMs) throw new CircuitOpenError(this.name, this.cooldownMs - waited);
      this.state = 'HALF_OPEN';
    }
    if (this.state === 'HALF_OPEN') {
      // Only one probe at a time; everyone else fails fast until it reports back.
      if (this.trialInFlight) throw new CircuitOpenError(this.name, 1_000);
      this.trialInFlight = true;
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      // Business errors (e.g. "sold out", HTTP 4xx) mean the supplier is healthy.
      if (isFailure(err)) this.onFailure();
      else this.onSuccess();
      throw err;
    } finally {
      this.trialInFlight = false;
    }
  }

  private onSuccess() {
    this.failures = 0;
    this.state = 'CLOSED';
  }

  private onFailure() {
    this.failures++;
    if (this.state === 'HALF_OPEN' || this.failures >= this.failureThreshold) {
      this.state = 'OPEN';
      this.openedAt = Date.now();
    }
  }
}
