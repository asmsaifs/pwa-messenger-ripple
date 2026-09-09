// Landing pane when no thread is selected (desktop two-pane). Real content
// arrives with ConversationDO in M6.
export function ChatsIndexPage() {
  return (
    <div className="hidden h-full flex-col items-center justify-center text-sm text-slate-400 lg:flex">
      Select a conversation to start chatting.
    </div>
  );
}
