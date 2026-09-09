import { Link, NavLink, Outlet, useMatch } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { useConversations } from '../lib/queries/conversations';
import type { ConversationSummary } from '@shared/conversations';

function relativeTime(ms: number | null): string {
  if (ms === null) return '';
  const diffSec = Math.max(0, (Date.now() - ms) / 1000);
  if (diffSec < 60) return 'now';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h`;
  return `${Math.floor(diffSec / 86400)}d`;
}

// docs/04 §2.1: kind-aware preview text — mirrors src/shared/messages.ts's
// `previewTextFor`, which the DO uses when it writes the D1 preview; this is
// a display-only fallback for a preview that predates that column existing
// (or hasn't flushed yet) rather than a second source of truth.
function previewFor(conversation: ConversationSummary): string {
  return conversation.lastMessagePreview ?? '';
}

// docs/04 §1: "Chromebook layout ≥1024 px: two-pane (list | thread). <1024
// px: stacked with back nav."
export function ChatShellLayout() {
  const threadMatch = useMatch('/c/:conversationId');
  const showThreadOnMobile = threadMatch !== null;

  return (
    <div className="grid min-h-0 flex-1 lg:grid-cols-[360px_1fr]">
      <aside
        className={cn(
          'min-h-0 overflow-y-auto border-slate-200 lg:block lg:border-r',
          showThreadOnMobile ? 'hidden' : 'block',
        )}
      >
        <ConversationListPane />
      </aside>
      <section className={cn('min-h-0 lg:block', showThreadOnMobile ? 'block' : 'hidden lg:block')}>
        <Outlet />
      </section>
    </div>
  );
}

function ConversationListPane() {
  const { data, isPending, isError } = useConversations();

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-14 items-center justify-between border-b border-slate-200 px-4">
        <h1 className="text-base font-semibold">Chats</h1>
      </div>

      {isPending && (
        <div className="flex flex-1 items-center justify-center text-sm text-slate-400">
          Loading…
        </div>
      )}

      {isError && (
        <div className="flex flex-1 items-center justify-center text-sm text-red-600">
          Couldn't load your conversations.
        </div>
      )}

      {data && data.conversations.length === 0 && (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-sm text-slate-500">
          <p>No conversations yet.</p>
          <Link to="/friends" className="text-blue-600 hover:underline">
            Invite a friend by email
          </Link>
        </div>
      )}

      {data && data.conversations.length > 0 && (
        <ul className="min-h-0 flex-1 overflow-y-auto">
          {data.conversations.map((conversation) => (
            <li key={conversation.id}>
              <NavLink
                to={`/c/${conversation.id}`}
                className={({ isActive }) =>
                  cn(
                    'flex items-center gap-3 border-b border-slate-100 px-4 py-3 hover:bg-slate-50',
                    isActive && 'bg-slate-100',
                  )
                }
              >
                <div className="relative shrink-0">
                  <div className="flex size-10 items-center justify-center rounded-full bg-slate-200 text-sm font-medium text-slate-600">
                    {conversation.peerDisplayName.slice(0, 1).toUpperCase()}
                  </div>
                  {/* presence dot stubbed 'online' pending UserDO (M7) */}
                  <span className="absolute right-0 bottom-0 size-2.5 rounded-full border-2 border-white bg-emerald-500" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-sm font-medium text-slate-900">
                      {conversation.peerDisplayName}
                    </span>
                    <span className="shrink-0 text-xs text-slate-400">
                      {relativeTime(conversation.lastMessageAt)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm text-slate-500">{previewFor(conversation)}</span>
                    {conversation.unreadCount > 0 && (
                      <span
                        data-testid="unread-badge"
                        className="flex size-5 shrink-0 items-center justify-center rounded-full bg-blue-600 text-xs font-medium text-white"
                      >
                        {conversation.unreadCount > 9 ? '9+' : conversation.unreadCount}
                      </span>
                    )}
                  </div>
                </div>
              </NavLink>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
