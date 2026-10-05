const NativeDate = globalThis.Date;
const frozen = NativeDate.parse("2026-10-04T23:30:00Z");

class ValidationDate extends NativeDate {
  constructor(...args) {
    super(...(args.length ? args : [ValidationDate.now()]));
  }
  static now() {
    return frozen;
  }
}
globalThis.Date = ValidationDate;
