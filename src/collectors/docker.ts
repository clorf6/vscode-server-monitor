import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';

export type DockerStatus = 'ok' | 'no-socket' | 'no-permission' | 'error';

export interface DockerContainer {
  id: string;
  name: string;
  image: string;
  state: string; // running, exited, paused, ...
  status: string; // "Up 3 hours"
  ports: string[];
  created: number;
}

interface RawContainer {
  Id: string;
  Names?: string[];
  Image: string;
  State: string;
  Status: string;
  Created: number;
  Ports?: { PublicPort?: number; PrivatePort: number; Type: string; IP?: string }[];
}

/** Docker Engine API over the unix socket — no `docker` CLI process per refresh. */
export class DockerClient {
  readonly socketPath = findSocket();

  async list(): Promise<{ status: DockerStatus; containers: DockerContainer[]; error?: string }> {
    if (!this.socketPath) return { status: 'no-socket', containers: [] };
    try {
      await fs.promises.access(this.socketPath, fs.constants.R_OK | fs.constants.W_OK);
    } catch {
      return { status: 'no-permission', containers: [] };
    }
    try {
      const raw = (await this.request('GET', '/containers/json?all=1')) as RawContainer[];
      const containers = raw.map((c) => ({
        id: c.Id,
        name: (c.Names?.[0] ?? c.Id.slice(0, 12)).replace(/^\//, ''),
        image: c.Image,
        state: c.State,
        status: c.Status,
        created: c.Created * 1000,
        ports: [...new Set((c.Ports ?? []).filter((p) => p.PublicPort).map((p) => `${p.PublicPort}→${p.PrivatePort}/${p.Type}`))],
      }));
      containers.sort((a, b) => Number(b.state === 'running') - Number(a.state === 'running') || a.name.localeCompare(b.name));
      return { status: 'ok', containers };
    } catch (err) {
      const msg = String((err as Error).message || err);
      return { status: /EACCES|permission/i.test(msg) ? 'no-permission' : 'error', containers: [], error: msg };
    }
  }

  async action(id: string, action: 'start' | 'stop' | 'restart'): Promise<void> {
    await this.request('POST', `/containers/${encodeURIComponent(id)}/${action}`);
  }

  private request(method: string, p: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const req = http.request({ socketPath: this.socketPath, path: p, method, timeout: 8000 }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          if ((res.statusCode ?? 500) >= 400) return reject(new Error(`${res.statusCode}: ${body.slice(0, 200)}`));
          try {
            resolve(body ? JSON.parse(body) : undefined);
          } catch (err) {
            reject(err);
          }
        });
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
      req.end();
    });
  }
}

function findSocket(): string | undefined {
  const host = process.env.DOCKER_HOST;
  const candidates: string[] = [];
  if (host?.startsWith('unix://')) candidates.push(host.slice(7));
  candidates.push('/var/run/docker.sock');
  if (process.env.XDG_RUNTIME_DIR) candidates.push(path.join(process.env.XDG_RUNTIME_DIR, 'docker.sock')); // rootless
  return candidates.find((c) => {
    try {
      return fs.statSync(c).isSocket();
    } catch {
      return false;
    }
  });
}
