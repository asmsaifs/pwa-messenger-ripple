// docs/04 §"Settings": "About (version, build sha, licenses)".
export function AboutSection() {
  return (
    <section className="border-t border-slate-200 pt-6 dark:border-slate-700">
      <h2 className="text-sm font-semibold">About</h2>
      <dl className="mt-3 space-y-2 text-sm">
        <div className="flex justify-between gap-4">
          <dt className="text-slate-500 dark:text-slate-400">Version</dt>
          <dd>{__APP_VERSION__}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-slate-500 dark:text-slate-400">Build</dt>
          <dd className="font-mono">{__APP_BUILD_SHA__}</dd>
        </div>
      </dl>
      {/* Open-source license listing is a `pnpm licenses` / license-checker
          build step, not wired up yet — deliberately not linking to a page
          that doesn't exist. */}
    </section>
  );
}
