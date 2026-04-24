// Injected into the PAGE context (not the content script isolated world) so we
// can intercept the blob downloads that Apple and Google trigger when the user
// generates an API key / service account key.
//
// Approach: wrap URL.createObjectURL. When the page calls it with a Blob whose
// type looks like a credentials artifact, we read the blob text and postMessage
// it back to the content script via window.postMessage.

(() => {
  if (
    (window as unknown as { __adaptyBlobHookInstalled?: boolean })
      .__adaptyBlobHookInstalled
  ) {
    return;
  }
  (
    window as unknown as { __adaptyBlobHookInstalled: boolean }
  ).__adaptyBlobHookInstalled = true;

  const originalCreate = URL.createObjectURL.bind(URL);

  URL.createObjectURL = function patched(obj: Blob | MediaSource): string {
    const url = originalCreate(obj);
    try {
      if (obj instanceof Blob) {
        const mime = obj.type || "";
        // Apple's .p8 is served as application/x-pem-file or octet-stream;
        // Google's service account JSON is application/json. Stay inclusive
        // and only filter out obvious non-credential mimes to keep the hook
        // cheap.
        const ignored = /^(image|video|audio|font)\//i;
        if (!ignored.test(mime)) {
          obj
            .text()
            .then((text) => {
              window.postMessage(
                {
                  source: "adapty-blob-hook",
                  type: "ADAPTY_BLOB",
                  mime,
                  text,
                },
                "*"
              );
            })
            .catch(() => {
              /* ignore */
            });
        }
      }
    } catch {
      // never break the host page
    }
    return url;
  };
})();
