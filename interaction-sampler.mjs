const SUPPORTED_RATES = new Set([30, 60, 120, 240]);
const RAW_CAPACITY = 256;
const STALE_MS = 200;
const MAX_SPEED = 12;
const MAX_ENDPOINT_WAIT_MS = 80;
const POSITION_EPSILON_SQ = 1e-16;
const TIME_EPSILON_MS = 1e-7;

function validateRate(hz) {
  if (!SUPPORTED_RATES.has(hz)) {
    throw new RangeError('Interaction sampling rate must be 30, 60, 120, or 240 Hz.');
  }
}

/**
 * Converts irregular pointer positions into evenly timed stroke impulses.
 *
 * Raw positions are retained in a small ring so rendering cadence does not
 * determine interaction cadence. The object passed to `drain` is reused;
 * consumers that need to retain it must copy its numeric fields.
 */
export class InteractionSampler {
  constructor(hz = 120) {
    validateRate(hz);
    this.hz = hz;
    this.intervalMs = 1000 / hz;

    this.rawX = new Float64Array(RAW_CAPACITY);
    this.rawY = new Float64Array(RAW_CAPACITY);
    this.rawTime = new Float64Array(RAW_CAPACITY);
    this.rawStart = 0;
    this.rawCount = 0;

    this.initialized = false;
    this.sampleX = 0;
    this.sampleY = 0;
    this.sampleTime = 0;
    this.nextTime = 0;
    this.lastRawTime = 0;
    this.observedRawGapMs = 0;
    this.hasRawSegment = false;

    this.sample = {
      fromX: 0,
      fromY: 0,
      toX: 0,
      toY: 0,
      vx: 0,
      vy: 0,
      time: 0,
    };
  }

  setRate(hz) {
    validateRate(hz);
    this.hz = hz;
    this.intervalMs = 1000 / hz;
    this.reset();
  }

  reset() {
    this.rawStart = 0;
    this.rawCount = 0;
    this.initialized = false;
    this.sampleX = 0;
    this.sampleY = 0;
    this.sampleTime = 0;
    this.nextTime = 0;
    this.lastRawTime = 0;
    this.observedRawGapMs = 0;
    this.hasRawSegment = false;
  }

  push(x, y, timeMs) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(timeMs)) {
      this.reset();
      return;
    }

    if (this.initialized && (timeMs < this.lastRawTime || timeMs - this.lastRawTime > STALE_MS)) {
      this.reset();
    }

    if (!this.initialized) {
      this.initialized = true;
      this.sampleX = x;
      this.sampleY = y;
      this.sampleTime = timeMs;
      this.nextTime = timeMs + this.intervalMs;
      this.lastRawTime = timeMs;
      this.#appendRaw(x, y, timeMs);
      return;
    }

    if (timeMs === this.lastRawTime) {
      const index = (this.rawStart + this.rawCount - 1) % RAW_CAPACITY;
      this.rawX[index] = x;
      this.rawY[index] = y;
      return;
    }

    const rawGapMs = timeMs - this.lastRawTime;
    // Follow cadence changes without letting a single unusually short event
    // make endpoint flushing race ahead of a slower input source.
    this.observedRawGapMs = this.observedRawGapMs === 0
      ? rawGapMs
      : Math.max(rawGapMs, this.observedRawGapMs * 0.8);
    this.hasRawSegment = true;
    this.lastRawTime = timeMs;
    this.#appendRaw(x, y, timeMs);
  }

  drain(nowMs, callback, limit = 32) {
    if (typeof callback !== 'function') throw new TypeError('callback must be a function.');
    if (!this.initialized || !Number.isFinite(nowMs) || limit <= 0) return 0;

    const callbackLimit = Math.max(0, Math.floor(limit));
    if (nowMs - this.lastRawTime > STALE_MS) {
      this.reset();
      return 0;
    }

    let emitted = 0;
    let iterations = 0;
    const maxIterations = callbackLimit + 64;

    while (emitted < callbackLimit && iterations < maxIterations) {
      let targetTime = this.nextTime;
      let allowHeldEndpoint = false;

      if (targetTime > this.lastRawTime + TIME_EPSILON_MS) {
        // Wait one complete sampling interval before treating the latest raw
        // point as the end of a stroke. This keeps normal event/render skew
        // from consuming timestamps that future pointer events still cover.
        // A lone anchor has no stroke to flush. Advancing its timeline would
        // consume interpolation slots before the first movement event arrives.
        if (!this.hasRawSegment) break;
        const endpointWaitMs = Math.min(
          MAX_ENDPOINT_WAIT_MS,
          Math.max(this.intervalMs, this.observedRawGapMs * 1.5),
        );
        if (nowMs - this.lastRawTime + TIME_EPSILON_MS < endpointWaitMs
          || targetTime > nowMs + TIME_EPSILON_MS) break;
        allowHeldEndpoint = true;
      }

      let toX;
      let toY;
      if (allowHeldEndpoint) {
        const latest = (this.rawStart + this.rawCount - 1) % RAW_CAPACITY;
        toX = this.rawX[latest];
        toY = this.rawY[latest];
      } else {
        this.#discardBefore(targetTime);
        const first = this.rawStart;
        if (this.rawCount === 1) {
          toX = this.rawX[first];
          toY = this.rawY[first];
        } else {
          const second = (first + 1) % RAW_CAPACITY;
          const fromTime = this.rawTime[first];
          const duration = this.rawTime[second] - fromTime;
          const alpha = duration > 0
            ? Math.max(0, Math.min(1, (targetTime - fromTime) / duration))
            : 1;
          toX = this.rawX[first] + (this.rawX[second] - this.rawX[first]) * alpha;
          toY = this.rawY[first] + (this.rawY[second] - this.rawY[first]) * alpha;
        }
      }

      const fromX = this.sampleX;
      const fromY = this.sampleY;
      const dx = toX - fromX;
      const dy = toY - fromY;
      const elapsedSeconds = Math.max((targetTime - this.sampleTime) / 1000, 1e-9);

      this.sampleX = toX;
      this.sampleY = toY;
      this.sampleTime = targetTime;
      this.nextTime = targetTime + this.intervalMs;
      iterations++;

      if (dx * dx + dy * dy <= POSITION_EPSILON_SQ) continue;

      let vx = dx / elapsedSeconds;
      let vy = dy / elapsedSeconds;
      const speed = Math.hypot(vx, vy);
      if (speed > MAX_SPEED) {
        const scale = MAX_SPEED / speed;
        vx *= scale;
        vy *= scale;
      }

      const sample = this.sample;
      sample.fromX = fromX;
      sample.fromY = fromY;
      sample.toX = toX;
      sample.toY = toY;
      sample.vx = vx;
      sample.vy = vy;
      sample.time = targetTime;
      callback(sample);
      emitted++;
    }

    return emitted;
  }

  #appendRaw(x, y, timeMs) {
    if (this.rawCount === RAW_CAPACITY) {
      // Keep the oldest bracketing point when possible and shed the next
      // oldest detail. Normal 240 Hz input drained at 30 FPS never reaches
      // this path; it only bounds pathological event floods.
      for (let i = 1; i < this.rawCount - 1; i++) {
        const from = (this.rawStart + i + 1) % RAW_CAPACITY;
        const to = (this.rawStart + i) % RAW_CAPACITY;
        this.rawX[to] = this.rawX[from];
        this.rawY[to] = this.rawY[from];
        this.rawTime[to] = this.rawTime[from];
      }
      this.rawCount--;
    }

    const index = (this.rawStart + this.rawCount) % RAW_CAPACITY;
    this.rawX[index] = x;
    this.rawY[index] = y;
    this.rawTime[index] = timeMs;
    this.rawCount++;
  }

  #discardBefore(targetTime) {
    while (this.rawCount > 1) {
      const second = (this.rawStart + 1) % RAW_CAPACITY;
      if (this.rawTime[second] + TIME_EPSILON_MS >= targetTime) break;
      this.rawStart = second;
      this.rawCount--;
    }
  }
}
