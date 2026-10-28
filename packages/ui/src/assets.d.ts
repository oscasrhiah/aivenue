declare module '*.svg' {
  const url: string;
  export default url;
}

/** Set by scripts/build.mjs (Vite define). */
declare const __AIVENUE_BUILD__: string;
