import { buildZipArchiveParts } from '../../shared/zipStore.js';
import {
  type ReceivedFileRecord,
  type SendableFileInput,
  wrapBrowserFile,
} from '../engine/warpClient.js';

interface WebkitEntry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  fullPath: string;
  file?: (cb: (file: File) => void, err?: (e: unknown) => void) => void;
  createReader?: () => {
    readEntries: (cb: (entries: WebkitEntry[]) => void, err?: (e: unknown) => void) => void;
  };
}

async function traverseEntry(entry: WebkitEntry): Promise<SendableFileInput[]> {
  if (entry.isFile && entry.file) {
    return new Promise((resolve) => {
      entry.file!(
        (f) => {
          const rel = entry.fullPath ? entry.fullPath.replace(/^\/+/, '') : f.name;
          resolve([wrapBrowserFile(f, rel)]);
        },
        () => resolve([])
      );
    });
  }

  if (entry.isDirectory && entry.createReader) {
    const reader = entry.createReader();
    const allEntries: WebkitEntry[] = [];

    const readBatch = (): Promise<WebkitEntry[]> =>
      new Promise((resolve) => {
        reader.readEntries(
          (batch) => resolve(batch),
          () => resolve([])
        );
      });

    while (true) {
      const batch = await readBatch();
      if (batch.length === 0) break;
      allEntries.push(...batch);
    }

    const nestedResults: SendableFileInput[] = [];
    for (const child of allEntries) {
      const childFiles = await traverseEntry(child);
      nestedResults.push(...childFiles);
    }
    return nestedResults;
  }

  return [];
}

export async function extractDroppedFiles(dataTransfer: DataTransfer): Promise<SendableFileInput[]> {
  const items = dataTransfer.items;
  if (items && items.length > 0) {
    const entries: WebkitEntry[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i] as DataTransferItem & { webkitGetAsEntry?: () => WebkitEntry | null };
      if (typeof item.webkitGetAsEntry === 'function') {
        const entry = item.webkitGetAsEntry();
        if (entry) entries.push(entry);
      }
    }

    if (entries.length > 0) {
      const out: SendableFileInput[] = [];
      for (const entry of entries) {
        const collected = await traverseEntry(entry);
        out.push(...collected);
      }
      if (out.length > 0) return out;
    }
  }

  return Array.from(dataTransfer.files || []).map((f) => wrapBrowserFile(f));
}

export function triggerSingleFileDownload(record: ReceivedFileRecord): void {
  const url =
    record.blobUrl ||
    URL.createObjectURL(new Blob(record.chunks as BlobPart[], { type: record.mimeType }));
  const a = document.createElement('a');
  a.href = url;
  a.download = record.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function triggerBatchZipDownload(
  records: ReceivedFileRecord[],
  archiveBaseName = 'AirBridge-Bundle'
): void {
  const zipParts = buildZipArchiveParts(
    records.map((r) => ({
      path: r.relativePath || r.name,
      chunks: r.chunks,
    }))
  );
  const blob = new Blob(zipParts as BlobPart[], { type: 'application/zip' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${archiveBaseName}.zip`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * Consume any shared files/text queued by the PWA Android Share Target Service Worker (`sw.js`).
 */
export async function consumePwaSharedPayload(): Promise<{
  files: SendableFileInput[];
  text: string;
} | null> {
  if (typeof indexedDB === 'undefined') return null;
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open('airbridge-share-db', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('shared-items')) {
          db.createObjectStore('shared-items', { keyPath: 'id' });
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('shared-items')) {
          resolve(null);
          return;
        }
        const tx = db.transaction('shared-items', 'readwrite');
        const store = tx.objectStore('shared-items');
        const getReq = store.get('latest');
        getReq.onsuccess = () => {
          const item = getReq.result as
            | { files?: File[]; title?: string; text?: string; url?: string }
            | undefined;
          if (!item) {
            resolve(null);
            return;
          }
          store.delete('latest');
          const files = (item.files || []).map((f) => wrapBrowserFile(f));
          const combinedText = [item.title, item.text, item.url]
            .filter(Boolean)
            .join('\n')
            .trim();
          resolve({ files, text: combinedText });
        };
        getReq.onerror = () => resolve(null);
      };
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}
