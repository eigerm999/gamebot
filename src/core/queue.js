import { failed } from './errors.js';

/**
 * Runs tasks one at a time. One queue per provider account: a portal login
 * is a single session, so its operations must never overlap.
 *
 * When more than maxWaiting tasks are already queued, new work is refused at
 * once ('busy') instead of holding the caller (and a PHP worker) for a long wait.
 */
export class SerialQueue {
  constructor(maxWaiting) {
    this.maxWaiting = maxWaiting;
    this.tail = Promise.resolve();
    this.waiting = 0;
    this.running = false;
  }

  get busy() {
    return this.running;
  }

  run(task) {
    if (this.waiting >= this.maxWaiting) {
      return Promise.reject(failed('busy', 'Too many requests in progress, try again shortly'));
    }

    this.waiting++;
    const result = this.tail.then(async () => {
      this.waiting--;
      this.running = true;
      try {
        return await task();
      } finally {
        this.running = false;
      }
    });
    this.tail = result.catch(() => {});
    return result;
  }

  /** Background work (e.g. startup login) that must not count against maxWaiting. */
  runInternal(task) {
    const result = this.tail.then(async () => {
      this.running = true;
      try {
        return await task();
      } finally {
        this.running = false;
      }
    });
    this.tail = result.catch(() => {});
    return result;
  }
}
