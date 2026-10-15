import * as vscode from 'vscode';
import { l10n } from 'vscode';
import { demandWhileVisible, GpuProc, Monitor } from '../monitor';
import { AlertManager } from '../alerts';
import { GpuInfo } from '../collectors/parsers';
import * as fmt from '../util/format';
import { icon, Node, shortCmd, TreeProvider, usageColor } from './common';
import { ProcTarget } from './processView';

export function registerGpuView(ctx: vscode.ExtensionContext, m: Monitor, alerts: AlertManager): void {
  const provider = new TreeProvider(() => roots());
  const view = vscode.window.createTreeView('serverMonitor.gpus', { treeDataProvider: provider });

  const render = () => {
    const gpus = m.gpu.latest?.gpus;
    if (m.gpuC.available === false) {
      view.message = m.gpuC.binary ? l10n.t('nvidia-smi found no GPUs.') : l10n.t('No NVIDIA GPU detected (nvidia-smi not found).');
      view.description = undefined;
    } else {
      view.message = gpus ? undefined : l10n.t('Loading…');
      view.description = gpus ? l10n.t('{0}/{1} free', m.freeGpus(gpus).length, gpus.length) : undefined;
    }
    provider.refresh();
  };

  function roots(): Node[] {
    const gpus = m.gpu.latest?.gpus ?? [];
    const apps = m.gpuApps.latest ?? [];
    const free = new Set(m.freeGpus(gpus).map((g) => g.index));
    return gpus.map((g) => gpuNode(g, apps.filter((a) => a.gpuIndex === g.index), free.has(g.index)));
  }

  function gpuNode(g: GpuInfo, procs: GpuProc[], free: boolean): Node {
    const memPct = g.memTotal ? (g.memUsed / g.memTotal) * 100 : 0;
    const users = [...new Set(procs.map((p) => p.user))];
    const desc = [
      `${fmt.pct(g.util).padStart(4)}`,
      `${fmt.mib(g.memUsed)}/${fmt.mib(g.memTotal)}`,
      isNaN(g.temp) ? '' : `${g.temp}°C`,
      isNaN(g.power) ? '' : `${Math.round(g.power)}W`,
      free ? l10n.t('free') : users.join(', '),
    ].filter(Boolean);
    const tip = new vscode.MarkdownString(undefined, true);
    tip.appendMarkdown(`**GPU ${g.index} · ${fmt.escapeMd(g.name)}**\n\n`);
    tip.appendMarkdown(`${l10n.t('Utilization')}: \`${fmt.bar(g.util, 20)}\` ${fmt.pct(g.util)}\n\n`);
    tip.appendMarkdown(`${l10n.t('GPU memory')}: \`${fmt.bar(memPct, 20)}\` ${fmt.mib(g.memUsed)} / ${fmt.mib(g.memTotal)}\n\n`);
    tip.appendMarkdown(`${l10n.t('Temperature')} ${isNaN(g.temp) ? '–' : g.temp + '°C'} · ${l10n.t('Power')} ${isNaN(g.power) ? '–' : g.power.toFixed(0)} / ${isNaN(g.powerLimit) ? '–' : g.powerLimit.toFixed(0)} W · ${l10n.t('Fan')} ${isNaN(g.fan) ? '–' : g.fan + '%'}\n\n`);
    tip.appendMarkdown(`\`${g.uuid}\``);
    return new Node(`GPU ${g.index}`, {
      id: `gpu:${g.uuid}`,
      description: desc.join(' · '),
      icon: free ? icon('circle-large-outline', 'charts.green') : icon('circle-large-filled', usageColor(Math.max(g.util, memPct))),
      contextValue: free ? 'gpu.free' : 'gpu',
      tooltip: tip,
      data: g,
      kids: procs.length ? () => procs.sort((a, b) => b.memMiB - a.memMiB).map((p) => gpuProcNode(g, p)) : undefined,
    });
  }

  function gpuProcNode(g: GpuInfo, p: GpuProc): Node {
    const mine = p.uid === m.names.myUid;
    const target: ProcTarget = { pid: p.pid, label: shortCmd(p.cmd), mine, start: m.procC.startTimeOf(p.pid) };
    return new Node(shortCmd(p.cmd), {
      id: `gpu:${g.uuid}:${p.pid}`,
      description: `${p.user} · ${fmt.mib(p.memMiB)} · pid ${p.pid}`,
      icon: icon(mine ? 'account' : 'person', mine ? 'charts.blue' : undefined),
      contextValue: mine ? 'proc.mine' : 'proc.other',
      tooltip: new vscode.MarkdownString().appendCodeblock(p.cmd, 'shell'),
      data: target,
    });
  }

  const freeIds = (n?: number) =>
    m
      .freeGpus()
      .slice(0, n)
      .map((g) => g.index)
      .join(',');

  ctx.subscriptions.push(
    provider,
    view,
    demandWhileVisible(view, 'gpuView', () => (m.gpuC.available === false ? [] : [m.gpu, m.gpuApps])),
    m.gpu.onData.event(render),
    m.gpuApps.onData.event(render),
    m.onConfig.event(render),

    vscode.commands.registerCommand('serverMonitor.copyFreeGpus', async () => {
      const gpus = m.gpu.latest?.gpus ?? (await m.gpuC.queryOnce())?.gpus;
      if (!gpus) return void vscode.window.showWarningMessage(l10n.t('No GPU data available.'));
      const ids = freeIds();
      if (!ids) return void vscode.window.showInformationMessage(l10n.t('No free GPU right now.'));
      await vscode.env.clipboard.writeText(`CUDA_VISIBLE_DEVICES=${ids}`);
      vscode.window.setStatusBarMessage(l10n.t('Copied CUDA_VISIBLE_DEVICES={0}', ids), 3000);
    }),

    vscode.commands.registerCommand('serverMonitor.gpu.copyIndex', async (n?: Node) => {
      const g = n?.data as GpuInfo | undefined;
      if (!g) return;
      await vscode.env.clipboard.writeText(`CUDA_VISIBLE_DEVICES=${g.index}`);
      vscode.window.setStatusBarMessage(l10n.t('Copied CUDA_VISIBLE_DEVICES={0}', g.index), 3000);
    }),

    vscode.commands.registerCommand('serverMonitor.pickGpus', async () => {
      const gpus = m.gpu.latest?.gpus ?? (await m.gpuC.queryOnce())?.gpus ?? [];
      if (!gpus.length) return void vscode.window.showWarningMessage(l10n.t('No GPU data available.'));
      const free = new Set(m.freeGpus(gpus).map((g) => g.index));
      const apps = m.gpuApps.latest ?? (await m.gpuApps.fetch()) ?? [];
      const items = gpus
        .map((g) => ({
          label: `${free.has(g.index) ? '$(circle-large-outline)' : '$(circle-large-filled)'} GPU ${g.index}`,
          description: `${fmt.pct(g.util)} · ${fmt.mib(g.memUsed)}/${fmt.mib(g.memTotal)}`,
          detail: free.has(g.index) ? l10n.t('free') : [...new Set(apps.filter((a) => a.gpuIndex === g.index).map((a) => a.user))].join(', '),
          picked: free.has(g.index),
          index: g.index,
          memFree: g.memTotal - g.memUsed,
        }))
        .sort((a, b) => Number(b.picked) - Number(a.picked) || b.memFree - a.memFree);
      const sel = await vscode.window.showQuickPick(items, { canPickMany: true, title: l10n.t('Select GPUs for CUDA_VISIBLE_DEVICES') });
      if (!sel?.length) return;
      const ids = sel.map((s) => s.index).sort((a, b) => a - b).join(',');
      const term = vscode.window.activeTerminal;
      const insert = l10n.t('Export in active terminal');
      const copy = l10n.t('Copy');
      const how = await vscode.window.showQuickPick(term ? [insert, copy] : [copy], { title: `CUDA_VISIBLE_DEVICES=${ids}` });
      if (how === insert && term) {
        term.show();
        term.sendText(`export CUDA_VISIBLE_DEVICES=${ids}`);
      } else if (how === copy) await vscode.env.clipboard.writeText(`CUDA_VISIBLE_DEVICES=${ids}`);
    }),

    vscode.commands.registerCommand('serverMonitor.watchFreeGpus', async () => {
      const total = m.gpu.latest?.gpus.length ?? m.gpuC.gpuCount;
      const v = await vscode.window.showInputBox({
        title: l10n.t('Notify me when GPUs become free'),
        prompt: l10n.t('How many free GPUs do you need? (free = less than {0} MiB used and under {1}% utilization)', m.cfg.gpuFreeMemoryMiB, m.cfg.gpuFreeUtilPercent),
        value: '1',
        validateInput: (s) => (/^\d+$/.test(s) && +s >= 1 && (!total || +s <= total) ? undefined : l10n.t('Enter a number between 1 and {0}', total || '∞')),
      });
      if (!v) return;
      alerts.add({ kind: 'gpuFree', count: +v, label: l10n.t('{0} free GPU(s)', v) });
    }),
  );
  render();
  void m.gpuC.detect().then(render);
}
