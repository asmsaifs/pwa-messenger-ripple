// docs/04 §"Settings": "About (version, build sha, licenses)".
export function AboutSection() {
  return (
    <section className="rounded-card border border-border-subtle bg-surface p-4 sm:p-5">
      <h2 className="font-display text-sm font-semibold text-ink">About</h2>
      <dl className="mt-3 space-y-2 text-sm">
        <div className="flex justify-between gap-4">
          <dt className="text-ink-muted">Version</dt>
          <dd>{__APP_VERSION__}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-ink-muted">Build</dt>
          <dd className="font-mono">{__APP_BUILD_SHA__}</dd>
        </div>
      </dl>
      {/* Open-source license listing is a `pnpm licenses` / license-checker
          build step, not wired up yet — deliberately not linking to a page
          that doesn't exist. */}
    </section>
  );
}
