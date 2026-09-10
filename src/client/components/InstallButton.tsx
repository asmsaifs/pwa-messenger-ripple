import { useInstallPrompt } from '../lib/install-prompt';
import { Button } from './ui/button';

export function InstallButton(props: {
  variant?: 'default' | 'outline' | 'ghost';
  size?: 'default' | 'sm' | 'lg';
  className?: string;
}) {
  const { canInstall, promptInstall } = useInstallPrompt();
  if (!canInstall) return null;

  return (
    <Button
      variant={props.variant ?? 'outline'}
      size={props.size}
      className={props.className}
      onClick={() => void promptInstall()}
    >
      Install app
    </Button>
  );
}
