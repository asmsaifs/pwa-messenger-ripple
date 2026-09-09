import { Link } from 'react-router-dom';

export function NotFoundPage() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-2 text-center">
      <h1 className="text-xl font-semibold">Page not found</h1>
      <Link to="/" className="text-sm text-blue-600 hover:underline">
        Go home
      </Link>
    </div>
  );
}
