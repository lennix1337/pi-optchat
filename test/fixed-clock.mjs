// Preload for a script run as a child process: `FIXED_NOW=<epoch ms> node --import ./test/fixed-clock.mjs script.mjs`
// makes Date.now() and `new Date()` return that instant, so a fixture dated on one day does not age out of its windows.
const fixed = Number(process.env.FIXED_NOW);
if (!Number.isFinite(fixed)) throw new Error('FIXED_NOW must be an epoch in milliseconds');
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...args) { if (args.length === 0) super(fixed); else super(...args); }
  static now() { return fixed; }
};
