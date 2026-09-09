import { createBrowserRouter } from 'react-router-dom';
import { PublicLayout } from '../layouts/PublicLayout';
import { AppLayout } from '../layouts/AppLayout';
import { ChatShellLayout } from '../layouts/ChatShellLayout';
import { RequireAuth } from '../layouts/RequireAuth';
import { RootRedirect } from '../routes/RootRedirect';
import { WelcomePage } from '../routes/WelcomePage';
import { LoginPage } from '../routes/LoginPage';
import { SignupPage } from '../routes/SignupPage';
import { ResetPage } from '../routes/ResetPage';
import { ResetConfirmPage } from '../routes/ResetConfirmPage';
import { InvitePreviewPage } from '../routes/InvitePreviewPage';
import { ChatsIndexPage } from '../routes/ChatsIndexPage';
import { ThreadPage } from '../routes/ThreadPage';
import { FriendsPage } from '../routes/FriendsPage';
import { SettingsPage } from '../routes/SettingsPage';
import { CallPage } from '../routes/CallPage';
import { NotFoundPage } from '../routes/NotFoundPage';

// Route map is docs/04 §1, verbatim. Screens not yet built by their owning
// milestone (M5 friends, M6 chat, M13 calls) render a placeholder so the
// shell, guards, and layouts are exercised end-to-end now.
export const router = createBrowserRouter([
  { path: '/', element: <RootRedirect /> },

  {
    element: <PublicLayout />,
    children: [
      { path: '/welcome', element: <WelcomePage /> },
      { path: '/login', element: <LoginPage /> },
      { path: '/signup', element: <SignupPage /> },
      { path: '/reset', element: <ResetPage /> },
      { path: '/reset/confirm', element: <ResetConfirmPage /> },
      { path: '/invite/:token', element: <InvitePreviewPage /> },
    ],
  },

  {
    element: <RequireAuth />,
    children: [
      { path: '/call/:callId', element: <CallPage /> },
      {
        element: <AppLayout />,
        children: [
          {
            element: <ChatShellLayout />,
            children: [
              { path: '/chats', element: <ChatsIndexPage /> },
              { path: '/c/:conversationId', element: <ThreadPage /> },
            ],
          },
          { path: '/friends', element: <FriendsPage /> },
          { path: '/settings', element: <SettingsPage /> },
        ],
      },
    ],
  },

  { path: '*', element: <NotFoundPage /> },
]);
