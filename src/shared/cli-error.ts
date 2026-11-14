/**
 * A failure the person running the CLI can act on: bad input, missing setup,
 * an unreachable server, a permission or a conflict. The message says what
 * happened in a sentence; `hint` is the command (or short instruction) that
 * fixes it, printed after `Fix:`. Anything else thrown as a plain `Error` is an
 * internal invariant or a broken server contract, not something to fix here.
 *
 * It lives in `src/shared/` so the shared helpers can throw it too;
 * `src/errors.ts` re-exports it.
 */
export class CliError extends Error {
  readonly hint?: string;

  constructor(message: string, hint?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CliError";
    this.hint = hint;
  }
}
