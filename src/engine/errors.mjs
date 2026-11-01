export const EXIT = {
  ok: 0,
  patch: 1,
  layout: 2,
  lock: 3,
  io: 4,
  notFound: 5,
  ambiguous: 6,
  conflict: 7,
  usage: 64,
};

export class ReverserError extends Error {
  /**
   * @param {keyof EXIT} kind
   * @param {string} message
   * @param {{path?: string, symbol?: string, errors?: any[], candidates?: any[]}} [extra]
   */
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = 'ReverserError';
    this.kind = kind;
    this.code = EXIT[kind] ?? 4;
    Object.assign(this, extra);
  }

  toJSON() {
    const { kind, code, message, path, symbol, errors, candidates } = this;
    return Object.fromEntries(
      Object.entries({ code, kind, message, path, symbol, errors, candidates }).filter(([, v]) => v !== undefined)
    );
  }
}

/** Wrap arbitrary errors into ReverserError of given kind (keeps existing ReverserError). */
export function asReverserError(error, kind) {
  if (error instanceof ReverserError) return error;
  const e = new ReverserError(kind, error?.message ?? String(error));
  const m = /(?:struct|Struct|Field|field)\s+"([A-Za-z_][\w]*)/.exec(e.message);
  if (m) e.symbol = m[1];
  return e;
}
