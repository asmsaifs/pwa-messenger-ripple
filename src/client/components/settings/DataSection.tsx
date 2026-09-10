import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { useDeleteAccount, useExportStatus, useStartExport } from '../../lib/queries/account';
import { messageForErrorCode } from '../../lib/errors/messages';
import { ApiError } from '../../lib/api';

// docs/04 §"Settings": "Data (Export, Delete account)".
export function DataSection() {
  const navigate = useNavigate();
  const startExport = useStartExport();
  const exportStatus = useExportStatus(startExport.data?.jobId);
  const deleteAccount = useDeleteAccount();

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [deleteError, setDeleteError] = useState<string | null>(null);

  function confirmDelete() {
    setDeleteError(null);
    deleteAccount.mutate(
      { password },
      {
        onSuccess: () => {
          setConfirmOpen(false);
          void navigate('/welcome', { replace: true });
        },
        onError: (err) => {
          setDeleteError(err instanceof ApiError ? messageForErrorCode(err.code) : 'Something went wrong.');
        },
      },
    );
  }

  return (
    <section className="border-t border-slate-200 pt-6 dark:border-slate-700">
      <h2 className="text-sm font-semibold">Data</h2>

      <div className="mt-3">
        <Button
          size="sm"
          variant="outline"
          disabled={startExport.isPending || exportStatus.data?.status === 'pending'}
          onClick={() => startExport.mutate()}
        >
          Export my data
        </Button>
        {exportStatus.data?.status === 'pending' && (
          <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
            Preparing your export — we'll notify you when it's ready.
          </p>
        )}
        {exportStatus.data?.status === 'ready' && exportStatus.data.downloadUrl && (
          <p className="mt-2 text-sm">
            <a
              href={exportStatus.data.downloadUrl}
              className="text-slate-900 underline dark:text-slate-50"
            >
              Download your data
            </a>
          </p>
        )}
        {exportStatus.data?.status === 'failed' && (
          <p className="mt-2 text-sm text-red-600 dark:text-red-400">
            Export failed — try again.
          </p>
        )}
      </div>

      <div className="mt-6">
        <Button size="sm" variant="destructive" onClick={() => setConfirmOpen(true)}>
          Delete account
        </Button>
      </div>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete your account?</DialogTitle>
            <DialogDescription>
              Your profile and messages are removed immediately from view; everything is
              permanently purged after 30 days. Enter your password to confirm.
            </DialogDescription>
          </DialogHeader>
          <label htmlFor="delete-account-password" className="sr-only">
            Password
          </label>
          <input
            id="delete-account-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900"
          />
          {deleteError && (
            <p className="mt-2 text-sm text-red-600 dark:text-red-400" role="alert">
              {deleteError}
            </p>
          )}
          <DialogFooter>
            <Button size="sm" variant="outline" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={!password || deleteAccount.isPending}
              onClick={confirmDelete}
            >
              Delete permanently
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
