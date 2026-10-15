import * as vscode from 'vscode';
import { l10n } from 'vscode';
import { getSysInfo } from '../collectors/sysinfo';

/** Human label for how this window reaches the machine being monitored. */
export function remoteLabel(): string {
  const r = vscode.env.remoteName;
  const si = getSysInfo();
  switch (r) {
    case 'ssh-remote':
      return 'SSH';
    case 'wsl':
      return 'WSL';
    case 'tunnel':
      return 'Tunnel';
    case 'dev-container':
    case 'attached-container':
      return l10n.t('Container');
    case 'codespaces':
      return 'Codespaces';
    case undefined:
      return si.wsl ? 'WSL' : si.container ? l10n.t('Container') : l10n.t('Local');
    default:
      return r;
  }
}
