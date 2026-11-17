// Agent-authored HTML runs on a synthetic origin. Only the scene and the
// explicitly listed task images are served; all other requests are denied.
import fs from 'node:fs/promises';
import path from 'node:path';

export async function installSceneRoutes(context, scenePath, assetRoot, allowedAssets) {
  const scene = await fs.readFile(scenePath);
  const assets = new Map();
  const root = await fs.realpath(assetRoot);
  for (const name of allowedAssets) {
    const resolved = await fs.realpath(path.resolve(root, name));
    if (!resolved.startsWith(root + path.sep)) throw new Error('素材路径越界');
    assets.set('/' + name.split(path.sep).join('/'), resolved);
  }
  await context.routeWebSocket('**/*', ws => ws.close());
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'https://video.invalid') return route.abort();
    if (url.pathname === '/scenes/scene.html') return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: scene });
    let pathname;
    try { pathname = decodeURIComponent(url.pathname); } catch { return route.abort(); }
    const file = assets.get(pathname);
    if (!file) return route.abort();
    const ext = path.extname(file).toLowerCase();
    const type = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp' }[ext];
    if (!type) return route.abort();
    return route.fulfill({ status: 200, contentType: type, body: await fs.readFile(file) });
  });
}
