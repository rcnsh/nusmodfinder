// Vite's `?raw` imports (a file's text), for workerd tests that read a doc (test/runbook.test.js).
declare module '*.md?raw' {
  const text: string;
  export default text;
}
