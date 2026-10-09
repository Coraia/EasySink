// Installed clients await the same save queues used by the browser before quitting.
export function installDesktopLifecycle() {
  const desktop = window.wiseReaderDesktop;
  if (!desktop?.nativeTrackpad) return;
  desktop.prepareToClose = async () => {
    const pending = [];
    window.dispatchEvent(new CustomEvent("reader-before-close", {
      detail: { waitUntil: promise => pending.push(Promise.resolve(promise)) },
    }));
    let timeout;
    try {
      return await Promise.race([
        Promise.all(pending).then(results => results.every(value => value !== false)),
        new Promise(resolve => { timeout = setTimeout(() => resolve(false), 5000); }),
      ]);
    } catch { return false; }
    finally { clearTimeout(timeout); }
  };
}
