import { useParams } from 'react-router-dom';

// Invite preview + accept-then-auto-friend flow is a M5 deliverable (docs/09,
// docs/03 §"Friends" `GET /api/invites/:token`). This stub reserves the
// (logged-out-accessible) route.
export function InvitePreviewPage() {
  const { token } = useParams<{ token: string }>();

  return (
    <div className="text-center">
      <h1 className="text-xl font-semibold">You've been invited</h1>
      <p className="mt-2 text-sm text-slate-500">Invite {token} — this is coming soon.</p>
    </div>
  );
}
