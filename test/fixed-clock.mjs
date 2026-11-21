

const fixed = Number(process.env.FIXED_NOW);
if (!Number.isFinite(fixed)) throw new Error('FIXED_NOW must be an epoch in milliseconds');
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...args) { if (args.length === 0) super(fixed); else super(...args); }
  static now() { return fixed; }
};
