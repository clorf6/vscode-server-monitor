import * as vscode from 'vscode';

export type StatusItem = 'cpu' | 'mem' | 'gpu' | 'gpuMem' | 'net' | 'load' | 'disk' | 'io';

export interface QuickCommand {
  name: string;
  command: string;
}

export interface Config {
  refreshInterval: number;
  backgroundMode: 'slow' | 'pause';
  backgroundInterval: number;
  statusBarEnabled: boolean;
  statusBarItems: StatusItem[];
  warnPercent: number;
  critPercent: number;
  gpuFreeMemoryMiB: number;
  gpuFreeUtilPercent: number;
  /** Minutes a GPU must sit idle while holding memory before it is flagged (0 = never). */
  gpuIdleHoldMinutes: number;
  alertsEnabled: boolean;
  alertMemoryPercent: number;
  alertDiskPercent: number;
  processScope: 'mine' | 'all';
  processLimit: number;
  diskExcludeFsTypes: string[];
  diskExcludeMounts: string[];
  diskNetworkTimeoutMs: number;
  dockerEnabled: boolean;
  historyMinutes: number;
  quickCommands: QuickCommand[];
  /** Also show the classic tree views below the sidebar panel. */
  sidebarTreeViews: boolean;
}

export const DEFAULT_QUICK_COMMANDS: QuickCommand[] = [
  { name: 'htop', command: 'htop' },
  { name: 'nvtop', command: 'nvtop' },
  { name: 'nvidia-smi (watch)', command: 'watch -n 1 nvidia-smi' },
];

export function readConfig(): Config {
  const c = vscode.workspace.getConfiguration('serverMonitor');
  return {
    refreshInterval: Math.max(500, c.get('refreshInterval', 2000)),
    backgroundMode: c.get('backgroundMode', 'slow'),
    backgroundInterval: Math.max(2000, c.get('backgroundInterval', 15000)),
    statusBarEnabled: c.get('statusBar.enabled', true),
    statusBarItems: c.get('statusBar.items', ['cpu', 'mem', 'gpu', 'net']),
    warnPercent: c.get('statusBar.warnPercent', 85),
    critPercent: c.get('statusBar.critPercent', 95),
    gpuFreeMemoryMiB: c.get('gpu.freeMemoryMiB', 500),
    gpuFreeUtilPercent: c.get('gpu.freeUtilPercent', 5),
    gpuIdleHoldMinutes: Math.max(0, c.get('gpu.idleHoldMinutes', 30)),
    alertsEnabled: c.get('alerts.enabled', true),
    alertMemoryPercent: c.get('alerts.memoryPercent', 90),
    alertDiskPercent: c.get('alerts.diskPercent', 95),
    processScope: c.get('processes.defaultScope', 'mine'),
    processLimit: Math.max(5, c.get('processes.limit', 50)),
    diskExcludeFsTypes: c.get('disk.excludeFsTypes', []),
    diskExcludeMounts: c.get('disk.excludeMounts', []),
    diskNetworkTimeoutMs: Math.max(500, c.get('disk.networkTimeoutMs', 3000)),
    dockerEnabled: c.get('docker.enabled', true),
    historyMinutes: Math.min(60, Math.max(1, c.get('history.minutes', 10))),
    quickCommands: c
      .get<QuickCommand[]>('quickCommands', DEFAULT_QUICK_COMMANDS)
      .filter((q) => q && typeof q.name === 'string' && typeof q.command === 'string' && q.command.trim()),
    sidebarTreeViews: c.get<boolean>('sidebar.showTreeViews', false) === true,
  };
}
