import { useInstallPrompt } from '../lib/install-prompt';
import { Button } from './ui/button';

export function InstallButton(props: { variant?: 'default' | 'outline' | 'ghost' }) {
  const { canInstall, promptInstall } = useInstallPrompt();
  if (!canInstall) return null;

  return (
    <Button variant={props.variant ?? 'outline'} onClick={() => void promptInstall()}>
      Install app
    </Button>
  );
}
