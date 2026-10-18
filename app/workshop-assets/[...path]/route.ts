// Serves workshop files downloaded by scripts/offline-assets.mjs from data/assets/.
import fs from 'fs/promises';
import path from 'path';
import { ASSETS_DIR } from '@/lib/workshop-data';

export const dynamic = 'force-dynamic';

const CONTENT_TYPES: Record<string, string> = {
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.jpe': 'image/jpeg',
  '.jfif': 'image/jpeg',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.zip': 'application/zip',
};

export async function GET(_req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const { path: segments } = await params;
  const filePath = path.resolve(/* turbopackIgnore: true */ ASSETS_DIR, ...segments);
  if (!filePath.startsWith(ASSETS_DIR + path.sep) || path.basename(filePath) === 'manifest.json') {
    return new Response('Not found', { status: 404 });
  }
  try {
    const body = await fs.readFile(filePath);
    return new Response(body, {
      headers: {
        'Content-Type': CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream',
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}
