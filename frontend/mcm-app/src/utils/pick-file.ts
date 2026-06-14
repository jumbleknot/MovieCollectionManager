/**
 * Web file picker (014 US2, T037).
 *
 * React Native Web has no file-input primitive, so the spreadsheet import opens a transient DOM
 * `<input type="file">` and resolves the chosen File. Web-only — the import/export flow is a
 * documented web-first parity exception (mobile returns null). Isolated in its own module so the
 * dialog stays unit-testable (the test mocks this helper rather than the DOM).
 */

/** Accepted spreadsheet extensions (content is validated server-side by spreadsheet-mcp). */
const ACCEPT = '.csv,.xlsx,.xlsm';

/**
 * Open the browser file chooser and resolve the selected file (or null if cancelled / non-web).
 *
 * Resolves null when there is no DOM (native / SSR). A cancelled chooser leaves the promise
 * pending — acceptable since the caller only acts on a returned File.
 */
export function pickSpreadsheetFile(): Promise<File | null> {
  if (typeof document === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = ACCEPT;
    input.style.display = 'none';
    input.onchange = () => {
      const file = input.files && input.files[0] ? input.files[0] : null;
      input.remove();
      resolve(file);
    };
    document.body.appendChild(input);
    input.click();
  });
}
