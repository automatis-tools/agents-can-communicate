let last = 0n;

// A tie-break for equal wall-clock milliseconds, captured in the caller before
// worker scheduling. Node's hrtime uses the OS monotonic clock; increment locally
// if its resolution produces a repeated tick. Wall time still orders other dates.
export function captureOfferOrder() {
  const tick = process.hrtime.bigint();
  last = tick > last ? tick : last + 1n;
  return last.toString();
}

export const validOfferOrder = value => typeof value === "string" && /^(0|[1-9]\d{0,19})$/.test(value);
