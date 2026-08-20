/**
 * Where sessions go.
 *
 * File System Access, not `chrome.downloads`, and the deciding argument is
 * **memory**: downloads would hold every MediaRecorder chunk in RAM until the
 * session stops (~170MB for fifteen minutes), while `createWritable()` streams
 * to disk as chunks arrive. The 200-entry download shelf and the collision
 * mangling — which would silently invalidate every `frame` path in
 * `timeline.json` — are real but secondary.
 *
 * Split of responsibility, forced by the platform:
 *
 *   - The **popup** picks the directory and re-grants permission, because
 *     `showDirectoryPicker` needs a window and `requestPermission` needs a user
 *     gesture. Neither exists in a service worker.
 *   - The **service worker** writes, reading the stored handle from IndexedDB.
 *     Handles work fine in a worker; only the picker does not.
 *
 * Design: docs/design/issues/10-how-artifacts-reach-disk.md
 */

import { idbGet, idbSet } from './idb';

const HANDLE_KEY = 'sessionDirectory';

/**
 * A session id that is also a legal filename everywhere.
 *
 * Colon-free by design — `T14-32-09`, never `T14:32:09` — because colons are
 * illegal in Windows filenames and this project is OS-agnostic by charter.
 * Sortable, and it names its own origin so a folder is identifiable without
 * opening anything.
 */
export function sessionId(startedAt: Date, pageUrl: string): string {
  const stamp = startedAt.toISOString().slice(0, 19).replace(/:/g, '-');
  let host = 'unknown';
  try {
    host = new URL(pageUrl).host || 'unknown';
  } catch {
    // Leave the default — a session is still worth writing without a clean host.
  }
  const slug = host.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
  return `${stamp}_${slug || 'unknown'}`;
}

export function fileSystemAccessAvailable(): boolean {
  // Enterprise policy can disable this outright
  // (DefaultFileSystemWriteGuardSetting), which is what the zip fallback exists
  // for — so this is a real runtime question, not a browser-version one.
  return typeof (globalThis as any).showDirectoryPicker === 'function';
}

/** Popup only — needs a window and a user gesture. */
export async function pickSessionDirectory(): Promise<FileSystemDirectoryHandle> {
  const handle = await (globalThis as any).showDirectoryPicker({
    id: 'bugcast-sessions',
    mode: 'readwrite',
    startIn: 'documents',
  });
  await idbSet(HANDLE_KEY, handle);
  return handle;
}

export const storedSessionDirectory = (): Promise<FileSystemDirectoryHandle | undefined> =>
  idbGet<FileSystemDirectoryHandle>(HANDLE_KEY);

/**
 * Whether the stored handle is usable right now.
 *
 * Expect `'prompt'` after a browser restart even though the handle itself
 * persisted — the grant does not survive with it. `request` re-grants but needs
 * a user gesture, so it must be called from the popup and never from the
 * worker.
 */
export async function permissionState(
  handle: FileSystemDirectoryHandle,
): Promise<PermissionState> {
  return (handle as any).queryPermission({ mode: 'readwrite' });
}

export async function requestPermission(handle: FileSystemDirectoryHandle): Promise<boolean> {
  return (await (handle as any).requestPermission({ mode: 'readwrite' })) === 'granted';
}

/** One file into a session folder, creating the folder if needed. */
export async function writeFile(
  dir: FileSystemDirectoryHandle,
  session: string,
  name: string,
  contents: string | Blob,
): Promise<void> {
  const folder = await dir.getDirectoryHandle(session, { create: true });
  // Nested paths — `frames/000012340.jpg` — need each segment created in turn.
  const segments = name.split('/');
  const file = segments.pop()!;
  let target = folder;
  for (const segment of segments) {
    target = await target.getDirectoryHandle(segment, { create: true });
  }
  const handle = await target.getFileHandle(file, { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(contents);
  } finally {
    await writable.close();
  }
}

/**
 * A writable that stays open, for streaming MediaRecorder chunks straight to
 * disk rather than accumulating them in memory. Used by #5.
 */
export async function openStream(
  dir: FileSystemDirectoryHandle,
  session: string,
  name: string,
): Promise<FileSystemWritableFileStream> {
  const folder = await dir.getDirectoryHandle(session, { create: true });
  const handle = await folder.getFileHandle(name, { create: true });
  return handle.createWritable();
}
