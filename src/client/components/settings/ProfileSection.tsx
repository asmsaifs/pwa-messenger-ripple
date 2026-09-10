import { useRef, useState } from 'react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Avatar } from '../ui/avatar';
import { useMe, useUpdateMe, useUploadAvatar } from '../../lib/queries/me';
import { MAX_AVATAR_BYTES } from '@shared/me';
import { ApiError } from '../../lib/api';
import { messageForErrorCode } from '../../lib/errors/messages';

// docs/04 §"Settings": "Profile (name, avatar crop, status)". Avatar crop
// isn't built here — it needs the same sign/complete R2 upload flow as
// attachments plus a crop UI, a bigger unit of work than the rest of this
// section; name/status editing (the part every other Settings section
// depends on `useMe` for anyway) is what this section covers.
export function ProfileSection() {
  const me = useMe();
  const update = useUpdateMe();
  const uploadAvatar = useUploadAvatar();
  const [editing, setEditing] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const [statusText, setStatusText] = useState('');
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const avatarInputRef = useRef<HTMLInputElement>(null);

  if (!me.data) return null;

  function handlePhotoPicked(file: File) {
    setAvatarError(null);
    if (!file.type.startsWith('image/')) {
      setAvatarError('Choose an image file.');
      return;
    }
    if (file.size > MAX_AVATAR_BYTES) {
      setAvatarError('That photo is too large (max 5 MB).');
      return;
    }
    uploadAvatar.mutate(file, {
      onError: (err) => {
        setAvatarError(err instanceof ApiError ? messageForErrorCode(err.code) : "Couldn't upload photo — try again.");
      },
    });
  }

  function startEditing() {
    setDisplayName(me.data!.profile.displayName);
    setStatusText(me.data!.profile.statusText ?? '');
    setEditing(true);
  }

  function save() {
    update.mutate(
      { displayName: displayName.trim(), statusText: statusText.trim() || null },
      { onSuccess: () => setEditing(false) },
    );
  }

  return (
    <section className="rounded-card border border-border-subtle bg-surface p-4 sm:p-5">
      <h2 className="font-display text-sm font-semibold text-ink">Profile</h2>

      <div className="mt-3 flex items-center gap-3">
        <div className="relative">
          <Avatar
            name={me.data.profile.displayName}
            avatarKey={me.data.profile.avatarKey}
            size="lg"
            presence="online"
          />
          <button
            type="button"
            onClick={() => avatarInputRef.current?.click()}
            disabled={uploadAvatar.isPending}
            aria-label="Change profile photo"
            className="absolute -right-1 -bottom-1 flex size-6 items-center justify-center rounded-full bg-brand-500 text-xs text-white shadow-sm transition-colors hover:bg-brand-600 disabled:opacity-50"
          >
            {uploadAvatar.isPending ? '…' : '📷'}
          </button>
          <input
            ref={avatarInputRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) handlePhotoPicked(file);
            }}
          />
        </div>
        {avatarError && (
          <p className="text-sm text-red-600 dark:text-red-400" role="alert">
            {avatarError}
          </p>
        )}
      </div>

      {editing ? (
        <div className="mt-3 space-y-3">
          <div>
            <label htmlFor="settings-display-name" className="text-xs text-ink-muted">
              Name
            </label>
            <Input
              id="settings-display-name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              maxLength={50}
              className="mt-1"
            />
          </div>
          <div>
            <label htmlFor="settings-status" className="text-xs text-ink-muted">
              Status
            </label>
            <Input
              id="settings-status"
              value={statusText}
              onChange={(e) => setStatusText(e.target.value)}
              maxLength={140}
              className="mt-1"
            />
          </div>
          {update.isError && (
            <p className="text-sm text-red-600 dark:text-red-400" role="alert">
              Couldn't save — try again.
            </p>
          )}
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={!displayName.trim() || update.isPending}
              onClick={save}
            >
              Save
            </Button>
            <Button size="sm" variant="outline" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <dl className="mt-3 space-y-2 text-sm">
          <div className="flex justify-between gap-4">
            <dt className="text-ink-muted">Name</dt>
            <dd className="text-right">{me.data.profile.displayName}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-ink-muted">Status</dt>
            <dd className="text-right">{me.data.profile.statusText || '—'}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-ink-muted">Email</dt>
            <dd className="text-right">{me.data.user.email}</dd>
          </div>
          <Button size="sm" variant="outline" className="mt-1" onClick={startEditing}>
            Edit profile
          </Button>
        </dl>
      )}
    </section>
  );
}
