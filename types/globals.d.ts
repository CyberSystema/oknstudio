// OKN Studio — Global augmentations
// =================================
// This file augments built-in types with project-specific globals.
// Because it uses `export {}` to become a module, its `declare global`
// blocks merge cleanly into the ambient Window/globalThis types.
//
// Keep ambient module declarations (for URL imports, non-existent
// packages, etc.) in a separate non-module file like esm-sh.d.ts —
// those must stay scripts to work correctly.

declare global {
  interface Window {
    __DARKROOM__: {
      onSettingsSave: () => Promise<void>;
      onSettingsExport: () => Promise<void>;
      onSettingsImport: (e: Event) => Promise<void>;
      onPanicReset: () => Promise<void>;
      closeResult: () => void;
    };
  }

  // Cloudflare Workers: `caches.default` is an extension to the standard
  // Cache API. Not present in lib.dom's CacheStorage interface. Declared
  // here so our Cloudflare Functions compile without pulling in the
  // heavyweight @cloudflare/workers-types devDep.
  interface CacheStorage {
    default: Cache;
  }

  // Our worker-pool / dispatcher convention is to tag errors with a
  // `klass` field (short string classifier like 'cancelled', 'corrupt',
  // 'unknown') so the UI can render the right Needs-attention category.
  // We augment Error globally so `err.klass = 'x'` and `err.klass` reads
  // type-check without casts.
  interface Error {
    klass?: string;
  }
}

// `export {}` is the idiom that marks this file as a module so
// `declare global` merges with ambient types. Without it, TypeScript
// treats the declarations as local to this file and other files don't
// see them.
export {};
