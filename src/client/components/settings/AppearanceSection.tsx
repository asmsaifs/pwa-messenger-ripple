import { Button } from '../ui/button';
import { useTheme, type ThemePreference } from '../../lib/theme';

const OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' },
];

export function AppearanceSection() {
  const { preference, setPreference } = useTheme();

  return (
    <section className="rounded-card border border-border-subtle bg-surface p-4 sm:p-5">
      <h2 className="font-display text-sm font-semibold text-ink">Appearance</h2>
      <div className="mt-3 flex gap-2" role="radiogroup" aria-label="Theme">
        {OPTIONS.map((opt) => (
          <Button
            key={opt.value}
            size="sm"
            variant={preference === opt.value ? 'default' : 'outline'}
            role="radio"
            aria-checked={preference === opt.value}
            onClick={() => setPreference(opt.value)}
          >
            {opt.label}
          </Button>
        ))}
      </div>
    </section>
  );
}
