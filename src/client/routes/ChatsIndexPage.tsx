import { MessageCircle } from 'lucide-react';

// Landing pane when no thread is selected (desktop two-pane). Real content
// arrives with ConversationDO in M6.
export function ChatsIndexPage() {
  return (
    <div className="hidden h-full flex-col items-center justify-center gap-2 text-ink-muted lg:flex">
      <MessageCircle className="size-8 text-slate-300 dark:text-slate-700" aria-hidden="true" />
      <p className="text-sm">Select a conversation to start chatting.</p>
    </div>
  );
}
