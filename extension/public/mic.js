/**
 * Requests the microphone grant.
 *
 * External rather than inline, and that is not style: `content_security_policy.
 * extension_pages` is `script-src 'self'` (needed for WebAssembly), which blocks
 * inline scripts outright. An inline version of this ran not at all and left the
 * page sitting on its initial "Requesting…" text forever — a failure with no
 * error, because nothing ever executed.
 */
const status = document.getElementById('status');
navigator.mediaDevices
  .getUserMedia({ audio: true })
  .then((stream) => {
    // The grant is what matters, not the stream — the offscreen document
    // opens its own once the permission exists.
    for (const track of stream.getTracks()) track.stop();
    status.textContent = 'Microphone enabled. You can close this tab and start recording.';
    status.className = 'ok';
  })
  .catch((e) => {
    status.textContent =
      `Not enabled (${e.name}). Without it a session still records video, network and ` +
      `console — there is simply no transcript.`;
    status.className = 'no';
  });
