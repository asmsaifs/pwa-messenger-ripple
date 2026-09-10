import { useEffect, useRef, useState } from 'react';
import { resolveVoiceMeta, resolveVoicePlaybackUrl } from '../lib/attachments';
import { ApiError } from '../lib/api';
import { messageForErrorCode } from '../lib/errors/messages';

function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

// docs/09 M11: "player with scrub and stored waveform". Renders bars from
// `attachments.waveform` on mount (no audio decode — docs/06 §4), and only
// spends a fetch on the actual bytes once the peer taps play.
export function VoiceMessagePlayer({ attachmentId, own }: { attachmentId: string; own: boolean }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [durationMs, setDurationMs] = useState<number | null>(null);
  const [waveform, setWaveform] = useState<number[] | null>(null);
  const [presignedUrl, setPresignedUrl] = useState<string | null>(null);
  const [playbackUrl, setPlaybackUrl] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0); // 0-1
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    resolveVoiceMeta(attachmentId)
      .then((meta) => {
        if (cancelled) return;
        setDurationMs(meta.durationMs);
        setWaveform(meta.waveform);
        setPresignedUrl(meta.url);
      })
      .catch(() => {
        // Waveform/duration are cosmetic — the play button still works via
        // a fresh presigned URL fetched lazily on tap if this failed.
      });
    return () => {
      cancelled = true;
    };
  }, [attachmentId]);

  useEffect(() => {
    return () => {
      if (playbackUrl) URL.revokeObjectURL(playbackUrl);
    };
  }, [playbackUrl]);

  async function handleToggle() {
    setError(null);
    const audio = audioRef.current;
    if (audio && playbackUrl) {
      if (playing) audio.pause();
      else void audio.play();
      return;
    }
    setLoading(true);
    try {
      let url: string | null = presignedUrl;
      if (!url) {
        const meta = await resolveVoiceMeta(attachmentId);
        url = meta.url;
      }
      const objectUrl = await resolveVoicePlaybackUrl(attachmentId, url);
      setPlaybackUrl(objectUrl);
    } catch (err) {
      setError(err instanceof ApiError ? messageForErrorCode(err.code) : 'Could not load this voice message.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !playbackUrl) return;
    void audio.play().catch(() => {});
  }, [playbackUrl]);

  function handleScrub(e: React.ChangeEvent<HTMLInputElement>) {
    const audio = audioRef.current;
    const ratio = Number(e.target.value) / 100;
    setProgress(ratio);
    if (audio && audio.duration) audio.currentTime = ratio * audio.duration;
  }

  const bars = waveform ?? new Array<number>(64).fill(20);
  const shownDuration = durationMs ?? 0;

  return (
    <div className="flex items-center gap-2" data-testid="voice-player">
      {playbackUrl && (
        <audio
          ref={audioRef}
          src={playbackUrl}
          data-testid="voice-audio-element"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => {
            setPlaying(false);
            setProgress(0);
          }}
          onTimeUpdate={(e) => {
            const audio = e.currentTarget;
            if (audio.duration) setProgress(audio.currentTime / audio.duration);
          }}
        />
      )}
      <button
        type="button"
        onClick={() => void handleToggle()}
        disabled={loading}
        aria-label={playing ? 'Pause voice message' : 'Play voice message'}
        data-testid="voice-play-toggle"
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs disabled:opacity-50 ${
          own ? 'bg-white/20 text-white' : 'bg-ink/10 text-ink'
        }`}
      >
        {loading ? '…' : playing ? '⏸' : '▶'}
      </button>
      <div
        className="relative h-8 min-w-0 flex-1 overflow-hidden"
        data-testid="voice-stored-waveform"
      >
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-full w-full" aria-hidden="true">
          {bars.map((level, i) => {
            const barWidth = 100 / bars.length;
            const height = Math.max(10, level);
            const played = i / bars.length <= progress;
            const fill = played
              ? own
                ? '#fff'
                : '#2563eb'
              : own
                ? 'rgba(255,255,255,0.4)'
                : '#cbd5e1';
            return (
              <rect
                key={i}
                x={i * barWidth + barWidth * 0.15}
                y={(100 - height) / 2}
                width={barWidth * 0.7}
                height={height}
                rx={barWidth * 0.35}
                fill={fill}
              />
            );
          })}
        </svg>
        <input
          type="range"
          min={0}
          max={100}
          value={Math.round(progress * 100)}
          onChange={handleScrub}
          aria-label="Scrub voice message"
          data-testid="voice-scrub"
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
        />
      </div>
      <span className="shrink-0 text-[10px] opacity-80">{error ?? formatDuration(shownDuration)}</span>
    </div>
  );
}
