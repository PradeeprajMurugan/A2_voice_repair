// Clocks. The dialogue manager never calls setTimeout directly, so the same code can run
// live in the browser (realClock) or deterministically in scenario replays (FakeClock).

export const realClock = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
};

export class FakeClock {
  constructor() {
    this.t = 0;
    this.nextId = 1;
    this.timers = new Map(); // id -> { at, fn }
  }
  now() { return this.t; }
  setTimeout(fn, ms) {
    const id = this.nextId++;
    this.timers.set(id, { at: this.t + ms, fn });
    return id;
  }
  clearTimeout(id) { this.timers.delete(id); }
  // Advance time, firing due timers in order (timers may schedule further timers).
  advance(ms) {
    const end = this.t + ms;
    for (;;) {
      let next = null;
      for (const [id, tm] of this.timers) {
        if (tm.at <= end && (!next || tm.at < next.at)) next = { id, ...tm };
      }
      if (!next) break;
      this.timers.delete(next.id);
      this.t = next.at;
      next.fn();
    }
    this.t = end;
  }
}
