import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';
import { resolveAttachmentUrl } from '../lib/attachments';
import type { Message } from '@shared/messages';

// Full-viewport image viewer with a thumbnail-strip gallery (docs/04 request:
// "open picture ... scaled to full window view with gallery view"). Rendered
// via a portal to `document.body` rather than inline in the thread — the
// virtualized row it would otherwise nest under sets an inline `transform`
// (docs/04 §2.2's virtualization), and a `transform`ed ancestor becomes the
// containing block for `position: fixed` descendants per the CSS spec, which
// silently shrank/mispositioned the previous inline overlay and was why its
// close button didn't register clicks where they visually appeared.
export function MediaGallery({
  images,
  startIndex,
  onClose,
}: {
  images: Message[];
  startIndex: number;
  onClose: () => void;
}) {
  const [index, setIndex] = useState(startIndex);
  const [urls, setUrls] = useState<Map<string, string>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const current = images[index];

  useEffect(() => {
    if (!current?.attachmentId || urls.has(current.attachmentId)) return;
    let cancelled = false;
    setError(null);
    void resolveAttachmentUrl(current.attachmentId)
      .then((url) => {
        if (cancelled) return;
        setUrls((prev) => new Map(prev).set(current.attachmentId!, url));
      })
      .catch(() => {
        if (!cancelled) setError('Could not load image.');
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.attachmentId]);

  useEffect(() => {
    return () => {
      for (const url of urls.values()) URL.revokeObjectURL(url);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const goTo = useCallback(
    (next: number) => setIndex(((next % images.length) + images.length) % images.length),
    [images.length],
  );

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowRight') goTo(index + 1);
      else if (e.key === 'ArrowLeft') goTo(index - 1);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, goTo, index]);

  async function handleDownload() {
    const attachmentId = current?.attachmentId;
    if (!attachmentId) return;
    setBusy(true);
    try {
      const url = urls.get(attachmentId) ?? (await resolveAttachmentUrl(attachmentId));
      const a = document.createElement('a');
      a.href = url;
      a.download = '';
      a.click();
    } catch {
      setError('Could not download this file.');
    } finally {
      setBusy(false);
    }
  }

  const currentUrl = current?.attachmentId ? urls.get(current.attachmentId) : undefined;

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex flex-col bg-black"
      data-testid="media-gallery"
      onClick={onClose}
    >
      <div
        className="flex shrink-0 items-center justify-end gap-2 p-3"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={() => void handleDownload()}
          disabled={busy || !currentUrl}
          data-testid="gallery-download"
          aria-label="Download"
          className="flex size-10 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20 disabled:opacity-40"
        >
          ⬇
        </button>
        <button
          type="button"
          onClick={onClose}
          data-testid="gallery-close"
          aria-label="Close"
          className="flex size-10 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20"
        >
          ✕
        </button>
      </div>

      <div className="relative flex min-h-0 flex-1 items-center justify-center px-2">
        {currentUrl ? (
          <img
            src={currentUrl}
            alt=""
            onClick={(e) => e.stopPropagation()}
            className="max-h-full max-w-full rounded-lg object-contain"
          />
        ) : (
          <span className="text-sm text-white/70">{error ?? 'Loading…'}</span>
        )}
        {images.length > 1 && (
          <>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                goTo(index - 1);
              }}
              aria-label="Previous"
              className="absolute left-2 flex size-10 items-center justify-center rounded-full bg-black/40 text-xl text-white hover:bg-black/60"
            >
              ‹
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                goTo(index + 1);
              }}
              aria-label="Next"
              className="absolute right-2 flex size-10 items-center justify-center rounded-full bg-black/40 text-xl text-white hover:bg-black/60"
            >
              ›
            </button>
          </>
        )}
      </div>

      {images.length > 1 && (
        <div
          className="flex shrink-0 gap-1.5 overflow-x-auto p-3"
          onClick={(e) => e.stopPropagation()}
          data-testid="gallery-thumbnails"
        >
          {images.map((m, i) => (
            <GalleryThumb
              key={m.clientId}
              message={m}
              active={i === index}
              onClick={() => setIndex(i)}
            />
          ))}
        </div>
      )}
    </div>,
    document.body,
  );
}

function GalleryThumb({
  message,
  active,
  onClick,
}: {
  message: Message;
  active: boolean;
  onClick: () => void;
}) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (message.attachmentId) {
      void resolveAttachmentUrl(message.attachmentId).then((u) => {
        if (!cancelled) setUrl(u);
      });
    }
    return () => {
      cancelled = true;
    };
  }, [message.attachmentId]);

  return (
    <button
      type="button"
      onClick={onClick}
      data-testid="gallery-thumbnail"
      className={cn(
        'size-14 shrink-0 overflow-hidden rounded-md border-2',
        active ? 'border-white' : 'border-transparent opacity-60',
      )}
    >
      {url ? (
        <img src={url} alt="" className="size-full object-cover" />
      ) : (
        <div className="size-full bg-white/10" />
      )}
    </button>
  );
}
