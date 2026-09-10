import { useEffect, useState } from 'react';
import { Button } from '../ui/button';
import { db } from '../../lib/db';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function computeCacheSize(): Promise<number> {
  let total = 0;
  await db.blobs.each((row) => {
    total += row.blob.size;
  });
  if (typeof caches !== 'undefined') {
    try {
      const cache = await caches.open('avatars');
      const keys = await cache.keys();
      for (const req of keys) {
        const res = await cache.match(req);
        const blob = await res?.blob();
        if (blob) total += blob.size;
      }
    } catch {
      // Cache Storage unavailable (private mode) — just report the Dexie half.
    }
  }
  return total;
}

// docs/04 §"Settings": "Storage (cache size + Clear cached media)". Two
// stores make up "cached media": Dexie's `blobs` table (downloaded
// attachment bytes, src/client/lib/db.ts) and the Workbox `avatars` Cache
// Storage entry (src/sw.ts) — both are pure re-fetchable cache, never the
// `messages`/`outbox` tables, which hold functional data this must not touch.
export function StorageSection() {
  const [size, setSize] = useState<number | null>(null);
  const [clearing, setClearing] = useState(false);

  useEffect(() => {
    void computeCacheSize().then(setSize);
  }, []);

  async function clearCache() {
    setClearing(true);
    try {
      await db.blobs.clear();
      if (typeof caches !== 'undefined') await caches.delete('avatars');
      setSize(await computeCacheSize());
    } finally {
      setClearing(false);
    }
  }

  return (
    <section className="border-t border-slate-200 pt-6 dark:border-slate-700">
      <h2 className="text-sm font-semibold">Storage</h2>
      <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
        {size === null ? 'Calculating…' : `${formatBytes(size)} of cached media on this device.`}
      </p>
      <Button
        size="sm"
        variant="outline"
        className="mt-3"
        disabled={clearing || size === 0}
        onClick={() => void clearCache()}
      >
        Clear cached media
      </Button>
    </section>
  );
}
