// Server-only loader for the workshop exports in data/ (builds.json, scripts.json,
// texturepacks.json). The files are private and gitignored, so every reader must
// tolerate them being absent. Entries are stored in the studio's featured-item
// shape ({ type, title, ..., itemData }); callers get the unwrapped itemData.
// Remote URLs that scripts/offline-assets.mjs has downloaded are swapped for
// local /workshop-assets/ paths.
import { existsSync } from 'fs';
import fs from 'fs/promises';
import path from 'path';

const WORKSHOP_FILES: Record<string, string[]> = {
  builds: ['builds.json'],
  textures: ['texturepacks.json', 'textures.json'],
  scripts: ['scripts.json'],
};
const URL_FIELDS = ['url', 'file', 'img'];

export const ASSETS_DIR = path.join(process.cwd(), 'data', 'assets');
export const ASSETS_ROUTE = '/workshop-assets';

const cache = new Map<string, unknown[]>();
let localAssets: Promise<Map<string, string>> | null = null;

function loadLocalAssets(): Promise<Map<string, string>> {
  localAssets ??= fs
    .readFile(path.join(ASSETS_DIR, 'manifest.json'), 'utf-8')
    .then((raw) => {
      const manifest = JSON.parse(raw) as Record<string, { file?: string }>;
      const map = new Map<string, string>();
      for (const [url, entry] of Object.entries(manifest)) {
        if (entry.file && existsSync(path.join(ASSETS_DIR, entry.file))) {
          map.set(url, `${ASSETS_ROUTE}/${entry.file.split(path.sep).map(encodeURIComponent).join('/')}`);
        }
      }
      return map;
    })
    .catch(() => new Map());
  return localAssets;
}

export function isWorkshopResource(resource: string): boolean {
  return resource in WORKSHOP_FILES;
}

export async function readWorkshopData<T>(resource: string): Promise<T[]> {
  const cached = cache.get(resource);
  if (cached) return cached as T[];
  for (const file of WORKSHOP_FILES[resource] ?? []) {
    let raw: string;
    try {
      raw = await fs.readFile(path.join(process.cwd(), 'data', file), 'utf-8');
    } catch {
      continue;
    }
    const local = await loadLocalAssets();
    const items = (JSON.parse(raw) as Record<string, unknown>[]).map((entry) => {
      const item = { ...((entry.itemData ?? entry) as Record<string, unknown>) };
      for (const field of URL_FIELDS) {
        const localPath = typeof item[field] === 'string' ? local.get(item[field]) : undefined;
        if (localPath) item[field] = localPath;
      }
      return item as T;
    });
    cache.set(resource, items);
    return items;
  }
  return [];
}
