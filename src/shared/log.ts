export function log(...args: unknown[]): void {
  console.log("[adapty-helper]", ...args);
}
export function warn(...args: unknown[]): void {
  console.warn("[adapty-helper]", ...args);
}
export function error(...args: unknown[]): void {
  console.error("[adapty-helper]", ...args);
}
