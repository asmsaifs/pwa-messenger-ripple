import { Link, Outlet, useMatch } from 'react-router-dom';
import { cn } from '@/lib/utils';

// docs/04 §1: "Chromebook layout ≥1024 px: two-pane (list | thread). <1024
// px: stacked with back nav." Real conversation data lands in M6 — this
// wires the responsive shell it will render into.
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
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-14 items-center justify-between border-b border-slate-200 px-4">
        <h1 className="text-base font-semibold">Chats</h1>
      </div>
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-sm text-slate-500">
        <p>No conversations yet.</p>
        <Link to="/friends" className="text-blue-600 hover:underline">
          Invite a friend by email
        </Link>
      </div>
    </div>
  );
}
