import { EventEmitter } from "node:events";
import { config } from "../config.js";

const clampPositive = (value, fallback) => {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return num;
};

const clampNonNegative = (value, fallback) => {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return fallback;
  return num;
};

const clampRatio = (value, fallback) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(1, Math.max(0, num));
};

const createQueueError = (code, message) => {
  const err = new Error(message);
  err.code = code;
  return err;
};

class QueueTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`Queue task timed out after ${timeoutMs} ms`);
    this.name = "QueueTimeoutError";
    this.code = "QUEUE_TIMEOUT";
    this.timeoutMs = timeoutMs;
  }
}

const sanitizeMaxQueueSize = (value) => {
  if (!Number.isFinite(value) || value <= 0) return Infinity;
  return Math.floor(value);
};

const deriveGlobalDefaults = () => {
  const q = config?.queue || {};
  return {
    autoStart: true,
    concurrency: clampPositive(q.concurrency, 1),
    maxQueueSize: sanitizeMaxQueueSize(q.maxQueueSize),
    timeoutMs: clampNonNegative(q.timeoutMs, 0),
    maxRetries: clampNonNegative(q.maxRetries, 0),
    retryDelayMs: clampNonNegative(q.retryDelayMs, 0),
    backoffFactor: clampPositive(q.backoffFactor, 1),
    jitter: clampRatio(q.jitter, 0),
    priority: Number.isFinite(q.priority) ? q.priority : 0,
    shouldRetry: null,
  };
};

const GLOBAL_DEFAULTS = deriveGlobalDefaults();

const normalizeOptions = (opts = {}) => {
  const normalized = { ...GLOBAL_DEFAULTS, ...opts };
  normalized.autoStart = normalized.autoStart === false ? false : true;
  normalized.concurrency = Math.max(
    1,
    Math.floor(
      clampPositive(normalized.concurrency, GLOBAL_DEFAULTS.concurrency)
    )
  );
  normalized.maxQueueSize =
    Number.isFinite(normalized.maxQueueSize) && normalized.maxQueueSize > 0
      ? Math.floor(normalized.maxQueueSize)
      : Infinity;
  normalized.timeoutMs = clampNonNegative(
    normalized.timeoutMs,
    GLOBAL_DEFAULTS.timeoutMs
  );
  normalized.maxRetries = clampNonNegative(
    normalized.maxRetries,
    GLOBAL_DEFAULTS.maxRetries
  );
  normalized.retryDelayMs = clampNonNegative(
    normalized.retryDelayMs,
    GLOBAL_DEFAULTS.retryDelayMs
  );
  normalized.backoffFactor = clampPositive(
    normalized.backoffFactor,
    GLOBAL_DEFAULTS.backoffFactor
  );
  normalized.jitter = clampRatio(normalized.jitter, GLOBAL_DEFAULTS.jitter);
  normalized.priority = Number.isFinite(normalized.priority)
    ? normalized.priority
    : GLOBAL_DEFAULTS.priority;
  normalized.shouldRetry =
    typeof normalized.shouldRetry === "function"
      ? normalized.shouldRetry
      : null;
  return normalized;
};

export class SimpleQueue extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = normalizeOptions(options);
    this.concurrency = this.options.concurrency;
    this.queue = [];
    this.activeCount = 0;
    this.lastTaskId = 0;
    this.paused = this.options.autoStart === false;
    this.stats = {
      enqueued: 0,
      completed: 0,
      failed: 0,
      retried: 0,
      timedOut: 0,
    };
    this._idleResolvers = [];
  }

  get size() {
    return this.queue.length;
  }

  get inFlight() {
    return this.activeCount;
  }

  get idle() {
    return this.queue.length === 0 && this.activeCount === 0;
  }

  setConcurrency(value) {
    const next = clampPositive(value, this.concurrency);
    if (next === this.concurrency) return;
    this.concurrency = next;
    this.emit("concurrency", next);
    this._drain();
  }

  pause(reason = "manual") {
    if (this.paused) return;
    this.paused = true;
    this.emit("pause", reason);
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    this.emit("resume");
    this._drain();
  }

  clear(error = createQueueError("QUEUE_CLEARED", "Queue cleared")) {
    while (this.queue.length) {
      const task = this.queue.shift();
      task.reject(error);
    }
    this.emit("cleared", error);
    this._resolveIdle();
  }

  destroy(error = createQueueError("QUEUE_DESTROYED", "Queue destroyed")) {
    this.pause("destroyed");
    this.clear(error);
    this.removeAllListeners();
  }

  async onIdle() {
    if (this.idle) return;
    await new Promise((resolve) => this._idleResolvers.push(resolve));
  }

  push(fn, opts = {}) {
    if (typeof fn !== "function") {
      return Promise.reject(
        createQueueError("QUEUE_INVALID_TASK", "Task must be a function")
      );
    }
    const limit = this.options.maxQueueSize;
    if (Number.isFinite(limit) && limit >= 0 && this.queue.length >= limit) {
      return Promise.reject(
        createQueueError("QUEUE_FULL", "Queue limit reached")
      );
    }
    const taskOptions = this._buildTaskOptions(opts);
    return new Promise((resolve, reject) => {
      const task = {
        id: ++this.lastTaskId,
        fn,
        resolve,
        reject,
        attempts: 0,
        priority: taskOptions.priority,
        timeoutMs: taskOptions.timeoutMs,
        maxRetries: taskOptions.maxRetries,
        retryDelayMs: taskOptions.retryDelayMs,
        backoffFactor: taskOptions.backoffFactor,
        jitter: taskOptions.jitter,
        shouldRetry: taskOptions.shouldRetry,
        metadata: taskOptions.metadata,
        enqueuedAt: Date.now(),
      };
      this.queue.push(task);
      this._sortQueue();
      this.stats.enqueued += 1;
      this.emit("enqueue", this.queue.length, task);
      if (!this.paused && this.options.autoStart !== false) {
        this._drain();
      }
    });
  }

  _buildTaskOptions(opts = {}) {
    return {
      priority:
        typeof opts.priority === "number"
          ? opts.priority
          : this.options.priority,
      timeoutMs: clampNonNegative(
        opts.timeoutMs,
        clampNonNegative(this.options.timeoutMs, 0)
      ),
      maxRetries: clampNonNegative(
        opts.maxRetries,
        clampNonNegative(this.options.maxRetries, 0)
      ),
      retryDelayMs: clampNonNegative(
        opts.retryDelayMs,
        clampNonNegative(this.options.retryDelayMs, 0)
      ),
      backoffFactor: clampPositive(
        opts.backoffFactor,
        clampPositive(this.options.backoffFactor, 1)
      ),
      jitter: clampRatio(opts.jitter, clampRatio(this.options.jitter, 0)),
      shouldRetry:
        typeof opts.shouldRetry === "function"
          ? opts.shouldRetry
          : typeof this.options.shouldRetry === "function"
          ? this.options.shouldRetry
          : null,
      metadata: opts.metadata || null,
    };
  }

  _sortQueue() {
    if (this.queue.length <= 1) return;
    this.queue.sort((a, b) => {
      if (b.priority === a.priority) return a.id - b.id;
      return b.priority - a.priority;
    });
  }

  _drain() {
    if (this.paused) return;
    while (this.activeCount < this.concurrency && this.queue.length > 0) {
      const task = this.queue.shift();
      this._runTask(task);
    }
    this._resolveIdle();
  }

  async _runTask(task) {
    this.activeCount += 1;
    this.emit("start", task);
    task.attempts += 1;
    const controller = new AbortController();
    let timeoutHandle = null;
    let timedOut = false;

    const execution = Promise.resolve().then(() =>
      task.fn({
        attempt: task.attempts,
        signal: controller.signal,
        metadata: task.metadata,
      })
    );

    let runner = execution;
    if (task.timeoutMs > 0) {
      const timeoutPromise = new Promise((_, reject) => {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          controller.abort();
          reject(new QueueTimeoutError(task.timeoutMs));
        }, task.timeoutMs);
        timeoutHandle.unref?.();
      });
      runner = Promise.race([execution, timeoutPromise]);
    }

    try {
      const result = await runner;
      task.resolve(result);
      this.stats.completed += 1;
      this.emit("success", result, task);
    } catch (err) {
      if (timedOut) {
        execution.catch(() => {});
        this.stats.timedOut += 1;
      }
      this._handleFailure(task, err);
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      this.activeCount -= 1;
      this.emit("settled", task);
      this._resolveIdle();
      this._drain();
    }
  }

  _handleFailure(task, error) {
    if (this._shouldRetry(task, error)) {
      this.stats.retried += 1;
      this._scheduleRetry(task, error);
      return;
    }
    this.stats.failed += 1;
    task.reject(error);
    this.emit("failure", error, task);
  }

  _shouldRetry(task, error) {
    const retriesSoFar = Math.max(0, task.attempts - 1);
    if (retriesSoFar >= task.maxRetries) return false;
    if (typeof task.shouldRetry === "function") {
      try {
        return task.shouldRetry(error, task);
      } catch {
        return false;
      }
    }
    return task.maxRetries > 0;
  }

  _scheduleRetry(task, error) {
    const delay = this._computeDelay(task);
    this.emit("retry", { task, delay, error });
    const requeue = () => {
      this.queue.push(task);
      this._sortQueue();
      this._drain();
    };
    if (delay <= 0) {
      requeue();
    } else {
      const handle = setTimeout(requeue, delay);
      handle.unref?.();
    }
  }

  _computeDelay(task) {
    const base = task.retryDelayMs;
    if (base <= 0) return 0;
    const backoff = Math.pow(task.backoffFactor || 1, task.attempts - 1);
    const rawDelay = base * backoff;
    if (!task.jitter) return Math.round(rawDelay);
    const spread = rawDelay * task.jitter;
    const jitter = (Math.random() * spread * 2 - spread) | 0;
    return Math.max(0, Math.round(rawDelay + jitter));
  }

  _resolveIdle() {
    if (!this.idle || this._idleResolvers.length === 0) return;
    while (this._idleResolvers.length) {
      const resolve = this._idleResolvers.shift();
      try {
        resolve();
      } catch {}
    }
  }

  snapshot() {
    return {
      size: this.size,
      inFlight: this.inFlight,
      paused: this.paused,
      concurrency: this.concurrency,
      stats: { ...this.stats },
    };
  }
}

SimpleQueue.TimeoutError = QueueTimeoutError;
