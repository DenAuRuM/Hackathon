import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const files = new Map([
  ['/', ['index.html', 'text/html']], ['/index.html', ['index.html', 'text/html']],
  ['/web/app.js', ['web/app.js', 'text/javascript']],
  ['/web/map.js', ['web/map.js', 'text/javascript']],
  ['/web/yandex-map.js', ['web/yandex-map.js', 'text/javascript']],
  ['/web/styles.css', ['web/styles.css', 'text/css']],
  ['/src/planner.js', ['src/planner.js', 'text/javascript']],
  ['/src/csv-import.js', ['src/csv-import.js', 'text/javascript']],
  ['/src/import-session.js', ['src/import-session.js', 'text/javascript']],
  ['/data/demo.json', ['data/demo.json', 'application/json']],
]);
for (const region of ['east', 'south-east', 'south-center']) {
  for (const type of ['source', 'matching']) {
    const path = `data/imported/${region}.${type}.json`;
    files.set(`/${path}`, [path, 'application/json']);
  }
}
const port = Number(process.env.PORT || 3000);
createServer(async (req, res) => {
  const file = files.get((req.url || '').split('?')[0]);
  if (!file || !['GET', 'HEAD'].includes(req.method)) {
    res.writeHead(404); res.end('Not found'); return;
  }
  try {
    const body = await readFile(new URL(file[0], import.meta.url));
    res.writeHead(200, { 'Content-Type': `${file[1]}; charset=utf-8`, 'Cache-Control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    res.writeHead(500); res.end('Cannot read file');
  }
}).listen(port, '127.0.0.1', () => console.log(`Помощник диспетчера: http://127.0.0.1:${port}`));
