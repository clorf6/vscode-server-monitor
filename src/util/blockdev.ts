import * as fs from 'fs';
import * as path from 'path';

/**
 * The physical disks (names in /sys/block) behind a mounted device: a partition's parent (/dev/nvme0n1p4 → nvme0n1),
 * the members of LVM / dm-crypt / md RAID devices (followed through /sys/block/<dev>/slaves). Results are cached; the
 * mapping changes only when disks are added or reassembled.
 */
const cache = new Map<string, { at: number; disks: string[] }>();
const TTL_MS = 120_000;

export function physicalDisksOf(device: string, physical: Set<string>): string[] {
  if (!device.startsWith('/dev/')) return [];
  const hit = cache.get(device);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.disks;
  let disks: string[] = [];
  try {
    disks = [...new Set(resolve(path.basename(fs.realpathSync(device)), physical, 0))].sort();
  } catch {
    /* gone, or not a block device */
  }
  cache.set(device, { at: Date.now(), disks });
  return disks;
}

function resolve(name: string, physical: Set<string>, depth: number): string[] {
  if (depth > 6) return [];
  if (physical.has(name)) return [name];
  const sys = `/sys/class/block/${name}`;
  if (fs.existsSync(`${sys}/partition`)) {
    try {
      return resolve(path.basename(path.dirname(fs.realpathSync(sys))), physical, depth + 1);
    } catch {
      return [];
    }
  }
  try {
    return fs.readdirSync(`/sys/block/${name}/slaves`).flatMap((s) => resolve(s, physical, depth + 1));
  } catch {
    return [];
  }
}
