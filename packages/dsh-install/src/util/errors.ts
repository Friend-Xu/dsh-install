/**
 * The project's one domain error type: a message plus a stable
 * machine-readable reason code. Every module that rejects user input or
 * reports a boundary failure throws or returns this shape; callers match on
 * the code, never on message text. Single definition point — domains import
 * it from here instead of from each other.
 * @module dsh-install/util/errors
 */

/** A domain failure with a stable machine-readable code. */
export class RegistryError extends Error {
  /** Stable reason code (see DESIGN.md's code matrix). */
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'RegistryError'
    this.code = code
  }
}
