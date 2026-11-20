import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { testnetRequest } from "./lib/testnet-service.js";

const routes = new Map([
  ['/', ['index.html', 'text/html']],
  ['/styles.css', ['styles.css', 'text/css']],
  ['/src/app.js', ['src/app.js', 'text/javascript']],
  ['/src/amm.js', ['src/amm.js', 'text/javascript']],
  ['/src/humid.js', ['src/humid.js', 'text/javascript']],
  ['/src/testnet.js', ['src/testnet.js', 'text/javascript']],
]);

createServer(async (request, response) => {
  const path = new URL(request.url, "http://localhost").pathname;
  if (path.startsWith("/api/")) return testnetRequest(request, response, path);
  const route = routes.get(path);
  if (!route || !['GET', 'HEAD'].includes(request.method)) {
    response.writeHead(404).end('Not found');
    return;
  }
  try {
    const body = await readFile(new URL(route[0], import.meta.url));
    response.writeHead(200, { 'Content-Type': route[1] + '; charset=utf-8' });
    response.end(request.method === 'HEAD' ? undefined : body);
  } catch {
    response.writeHead(500).end('Unable to load application');
  }
}).listen(Number(process.env.PORT || 5173), process.env.HOST || '127.0.0.1', function () {
  console.log('Vibeswap listening on port ' + this.address().port);
});
