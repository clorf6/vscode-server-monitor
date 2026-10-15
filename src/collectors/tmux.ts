import { parseTmuxPanes, TMUX_FORMAT, TmuxSession } from './parsers';
import { run, which } from '../util/exec';

export interface TmuxState {
  installed: boolean;
  sessions: TmuxSession[];
}

export const SHELLS = new Set(['bash', 'zsh', 'sh', 'fish', 'dash', 'ksh', 'tcsh', 'csh', 'nu', 'elvish', 'xonsh']);

export class TmuxClient {
  readonly binary = which('tmux');

  async list(): Promise<TmuxState> {
    if (!this.binary) return { installed: false, sessions: [] };
    const r = await this.exec(['list-panes', '-a', '-F', TMUX_FORMAT]);
    // "no server running" / "error connecting" just mean there are no sessions.
    return { installed: true, sessions: r.code === 0 ? parseTmuxPanes(r.stdout) : [] };
  }

  async capture(target: string, lines = 300): Promise<string> {
    const r = await this.exec(['capture-pane', '-p', '-J', '-S', `-${lines}`, '-t', target]);
    if (r.code !== 0) throw new Error(r.stderr.trim() || 'capture-pane failed');
    return r.stdout.replace(/\n+$/, '\n');
  }

  async newSession(name: string, cwd?: string): Promise<void> {
    const args = ['new-session', '-d', '-s', name];
    if (cwd) args.push('-c', cwd);
    await this.check(args);
  }

  renameSession(target: string, name: string): Promise<void> {
    return this.check(['rename-session', '-t', target, name]);
  }

  killSession(target: string): Promise<void> {
    return this.check(['kill-session', '-t', target]);
  }

  killWindow(target: string): Promise<void> {
    return this.check(['kill-window', '-t', target]);
  }

  killPane(target: string): Promise<void> {
    return this.check(['kill-pane', '-t', target]);
  }

  sendCtrlC(target: string): Promise<void> {
    return this.check(['send-keys', '-t', target, 'C-c']);
  }

  private async check(args: string[]): Promise<void> {
    const r = await this.exec(args);
    if (r.code !== 0) throw new Error(r.stderr.trim() || `tmux ${args[0]} failed`);
  }

  private exec(args: string[]) {
    // Talk to the default server even if the extension host itself was started inside tmux.
    const env = { ...process.env };
    delete env.TMUX;
    return run(this.binary!, args, { timeoutMs: 4000, env });
  }
}
