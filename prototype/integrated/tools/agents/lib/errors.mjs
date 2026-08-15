export const EXIT = Object.freeze({
  OK: 0,
  USAGE: 2,
  TIMEOUT: 3,
  DATA: 4,
  CONFLICT: 5,
  REQUIRED: 6,
});

export class CommsError extends Error {
  constructor(message, exitCode, details = null) {
    super(message);
    this.name = "CommsError";
    this.exitCode = exitCode;
    this.details = details;
  }
}
