// Test-only clock. A callback lets replay timelines advance while every Date
// entry point observes the same instant; explicit Date arguments stay native.
export function freezeTestClock(now) {
  const NativeDate = globalThis.Date;
  const readNow = typeof now === 'function' ? now : () => now;
  globalThis.Date = new Proxy(NativeDate, {
    apply() { return new NativeDate(readNow()).toString(); },
    construct(target, args, newTarget) {
      return Reflect.construct(target, args.length ? args : [readNow()], newTarget);
    },
    get(target, key, receiver) {
      return key === 'now' ? readNow : Reflect.get(target, key, receiver);
    },
  });
  return () => { globalThis.Date = NativeDate; };
}
