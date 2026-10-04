/**
 * Freeze the complete wall clock for a replay without changing timers.
 * A callback follows the replay's advancing historical timestamp.
 *
 * @param {number | (() => number)} nowMs
 * @returns {() => void} Restore the original Date constructor and statics.
 */
export function installTestClock(nowMs) {
  const OriginalDate = globalThis.Date;
  const readNow = typeof nowMs === "function" ? nowMs : () => nowMs;
  const ClockDate = new Proxy(OriginalDate, {
    apply() {
      // Calling Date() ignores arguments and returns the current date string.
      return new OriginalDate(readNow()).toString();
    },
    construct(target, args, newTarget) {
      return Reflect.construct(target, args.length ? args : [readNow()], newTarget);
    },
    get(target, property, receiver) {
      return property === "now" ? readNow : Reflect.get(target, property, receiver);
    },
  });
  globalThis.Date = ClockDate;
  return () => { globalThis.Date = OriginalDate; };
}
