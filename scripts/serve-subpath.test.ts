// Production static server (scripts/serve-subpath.mjs): routing and robustness.
import { spawn, type ChildProcess } from 'node:child_process';
import { request } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let proc: ChildProcess;
let port = 0;

function get(path: string): Promise<{ status: number; location?: string }> {
  return new Promise((resolve, reject) => {
    // Raw path, so malformed escapes and dot segments reach the server unchanged.
    const r = request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode ?? 0, location: res.headers.location }));
    });
    r.on('error', reject);
    r.end();
  });
}

beforeAll(async () => {
  proc = spawn(process.execPath, ['scripts/serve-subpath.mjs', '0', '/centrifuge/'], { stdio: ['ignore', 'pipe', 'inherit'] });
  port = await new Promise<number>((resolve, reject) => {
    let out = '';
    proc.stdout!.on('data', (d: Buffer) => {
      out += d.toString();
      const m = /:(\d+)\/centrifuge\//.exec(out);
      if (m) resolve(Number(m[1]));
    });
    proc.on('exit', (code) => reject(new Error(`server exited with ${code}`)));
  });
});

afterAll(() => {
  proc?.kill();
});

describe('production server', () => {
  it('answers the health check', async () => {
    expect((await get('/healthz')).status).toBe(200);
  });

  it('redirects the root and the bare base path to the base path', async () => {
    expect(await get('/')).toEqual({ status: 302, location: '/centrifuge/' });
    expect(await get('/centrifuge')).toEqual({ status: 302, location: '/centrifuge/' });
  });

  it('does not serve outside the base path or outside dist/', async () => {
    expect((await get('/elsewhere/index.html')).status).toBe(404);
    expect((await get('/centrifuge/%2e%2e%2f%2e%2e%2fpackage.json')).status).toBe(403);
    expect((await get('/centrifuge/../package.json')).status).toBe(404);
  });

  it('rejects malformed URLs without crashing', async () => {
    expect((await get('/centrifuge/%E0%A4%A')).status).toBe(400);
    expect((await get('/healthz')).status).toBe(200);
    expect(proc.exitCode).toBeNull();
  });
});
