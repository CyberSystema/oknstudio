// OKN Studio — Ambient declarations for esm.sh URL imports
// =========================================================
// TypeScript doesn't resolve URL-based module specifiers by default.
// We import libraries directly from esm.sh (our project convention:
// no npm build step, all deps pinned via URL). These declarations
// tell tsc "any import from https://esm.sh/... is legit — treat
// every symbol as `any`."
//
// IMPORTANT: this file must remain a SCRIPT, not a module. Any top-level
// `import` or `export` statement turns it into a module, and TypeScript
// then ignores its ambient `declare module` blocks for files outside
// its own scope. Keep window augmentation and other `declare global`
// work in types/globals.d.ts instead.

// Wildcard pattern — catches any esm.sh URL we haven't explicitly
// enumerated. Default export is typed `any`, so destructured named
// exports also resolve to `any` through the index signature.
declare module 'https://esm.sh/*' {
  const anyDefault: any;
  export default anyDefault;
}

// TypeScript treats each unique module specifier as a distinct module,
// so we re-declare the exact URLs we use. This also lets us document
// which libraries we actually depend on — grep `esm.sh/` across the repo
// and these should match.
declare module 'https://esm.sh/piexifjs@1.0.6?bundle' {
  const piexif: any;
  export default piexif;
}
declare module 'https://esm.sh/exifr@7.1.3?bundle' {
  const exifr: any;
  export default exifr;
}
declare module 'https://esm.sh/client-zip@2.4.5?bundle' {
  export const downloadZip: any;
}
declare module 'https://esm.sh/idb-keyval@6.2.1?bundle' {
  export const createStore: any;
  export const get: any;
  export const set: any;
  export const del: any;
  export const keys: any;
  export const clear: any;
}
