import { Link, useParams } from 'react-router-dom';

// Thread view — ConversationDO + WS protocol land in M6 (docs/09).
export function ThreadPage() {
  const { conversationId } = useParams<{ conversationId: string }>();

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-14 items-center gap-3 border-b border-slate-200 px-4">
        <Link to="/chats" className="text-sm text-slate-500 hover:text-slate-900 lg:hidden">
          ← Back
        </Link>
        <span className="text-sm font-medium">Conversation {conversationId}</span>
      </div>
      <div className="flex flex-1 items-center justify-center text-sm text-slate-400">
        Messaging is coming soon.
      </div>
    </div>
  );
}
