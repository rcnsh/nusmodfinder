// public/_headers, imported as text by test/visitor.test.js (test/wrangler.test.jsonc's Text rule),
// which checks the 404's headers against the file. The Worker itself never imports it.
declare module '*/_headers' {
  const value: string;
  export default value;
}
