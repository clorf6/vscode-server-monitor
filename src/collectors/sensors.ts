import * as fs from 'fs';
import * as path from 'path';

/**
 * Temperatures from /sys/class/hwmon: the CPU package (coretemp, k10temp, zenpower, ARM thermal zones) and drives
 * (NVMe controllers, SATA disks through drivetemp). The sensor list is found once and refreshed every few minutes;
 * values are read at most every few seconds (an NVMe reading asks the controller).
 */
export interface Temps {
  /** Hottest CPU package, °C. */
  cpu?: number;
  /** Block device name (as in /sys/block) → °C. */
  disks: Record<string, number>;
}

interface Sensor {
  file: string;
  kind: 'cpu' | 'disk';
  disks?: string[];
}

const ROOT = '/sys/class/hwmon';
const CPU_DRIVERS = new Set(['coretemp', 'k10temp', 'zenpower', 'cpu_thermal', 'soc_thermal', 'x86_pkg_temp']);
const REDISCOVER_MS = 300_000;
const READ_MS = 5000;

const readText = (f: string): string | undefined => {
  try {
    return fs.readFileSync(f, 'utf8').trim();
  } catch {
    return undefined;
  }
};

export class Sensors {
  private sensors?: Sensor[];
  private foundAt = 0;
  private last?: { t: number; v: Temps };

  read(): Temps {
    const now = Date.now();
    if (this.last && now - this.last.t < READ_MS) return this.last.v;
    if (!this.sensors || now - this.foundAt > REDISCOVER_MS) {
      this.sensors = discover();
      this.foundAt = now;
    }
    const v: Temps = { disks: {} };
    for (const s of this.sensors) {
      const raw = readText(s.file);
      const c = raw === undefined ? NaN : Number(raw) / 1000;
      if (!isFinite(c) || c <= 0 || c > 150) continue;
      if (s.kind === 'cpu') v.cpu = Math.max(v.cpu ?? -Infinity, c);
      else for (const d of s.disks ?? []) v.disks[d] = Math.max(v.disks[d] ?? -Infinity, c);
    }
    this.last = { t: now, v };
    return v;
  }
}

/** Every useful temperature input under /sys/class/hwmon. */
function discover(): Sensor[] {
  const out: Sensor[] = [];
  let dirs: string[];
  try {
    dirs = fs.readdirSync(ROOT);
  } catch {
    return out;
  }
  for (const d of dirs) {
    const dir = path.join(ROOT, d);
    const name = readText(path.join(dir, 'name'));
    if (!name) continue;
    const inputs = tempInputs(dir);
    if (!inputs.length) continue;
    if (CPU_DRIVERS.has(name)) {
      const pick = (re: RegExp) => inputs.filter((i) => re.test(i.label));
      // the package reading where there is one (coretemp), the die temperature on AMD
      const chosen = name === 'coretemp' ? pick(/^Package id/) : name === 'k10temp' || name === 'zenpower' ? (pick(/^Tdie/).length ? pick(/^Tdie/) : pick(/^Tctl/)) : [];
      for (const i of chosen.length ? chosen : inputs.slice(0, 1)) out.push({ file: i.file, kind: 'cpu' });
    } else if (name === 'nvme' || name === 'drivetemp') {
      const disks = drivesOf(dir, name);
      if (!disks.length) continue;
      const composite = inputs.find((i) => /^Composite/.test(i.label)) ?? inputs[0];
      out.push({ file: composite.file, kind: 'disk', disks });
    }
  }
  return out;
}

function tempInputs(dir: string): { file: string; label: string }[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => /^temp\d+_input$/.test(n))
    .sort((a, b) => parseInt(a.slice(4)) - parseInt(b.slice(4)))
    .map((n) => ({ file: path.join(dir, n), label: readText(path.join(dir, n.replace('_input', '_label'))) ?? '' }));
}

/** Block devices a drive sensor belongs to: an NVMe controller's namespaces (nvme0 → nvme0n1), a SATA disk (sda). */
function drivesOf(dir: string, driver: string): string[] {
  try {
    const dev = fs.realpathSync(path.join(dir, 'device'));
    if (driver === 'nvme') {
      const ctrl = path.basename(dev); // nvme0
      return fs.readdirSync('/sys/block').filter((b) => b.startsWith(ctrl + 'n'));
    }
    return fs.readdirSync(path.join(dev, 'block'));
  } catch {
    return [];
  }
}
