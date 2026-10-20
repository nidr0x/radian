import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { buildPrecacheManifest } from '../vite.config';

type WorkerResponse = {
  readonly ok: boolean;
  readonly redirected: boolean;
  readonly type: string;
  text(): Promise<string>;
};

type WorkerRequest = {
  readonly method: string;
  readonly mode: string;
  readonly url: string;
};

type WorkerEvent = {
  readonly request?: WorkerRequest;
  respondWith?(response: Promise<WorkerResponse>): void;
  waitUntil?(promise: Promise<unknown>): void;
};

type WorkerHandler = (event: WorkerEvent) => void;

const html = '<script type="module" src="/assets/app.js"></script>';
const currentHtml = `${html}<meta name="radian-pwa-version" content="2" />`;

const responseFor = (path: string, body = html): WorkerResponse => ({
  ok: true,
  redirected: path === '/index.html',
  type: 'basic',
  text: async () => body,
});

class FakeCache {
  private readonly entries = new Map<string, WorkerResponse>();

  set(path: string, response: WorkerResponse): void {
    this.entries.set(path, response);
  }

  async addAll(paths: string[]): Promise<void> {
    await Promise.all(paths.map(async (path) => this.entries.set(path, responseFor(path))));
  }

  async match(request: string | WorkerRequest): Promise<WorkerResponse | undefined> {
    const path = typeof request === 'string' ? request : new URL(request.url).pathname;
    return this.entries.get(path);
  }

  async put(request: WorkerRequest, response: WorkerResponse): Promise<void> {
    this.entries.set(new URL(request.url).pathname, response);
  }
}

class FakeCacheStorage {
  readonly cache = new FakeCache();

  constructor(private readonly legacyCache?: FakeCache) {}

  async open(name: string): Promise<FakeCache> {
    return name === 'radian-shell-__BUILD_ID__' ? this.cache : this.legacyCache ?? this.cache;
  }

  async keys(): Promise<string[]> {
    return this.legacyCache ? ['radian-shell-old'] : [];
  }
}

const loadWorker = (legacyCache?: FakeCache): { handlers: Map<string, WorkerHandler>; caches: FakeCacheStorage; skipWaitingCalls: () => number } => {
  const handlers = new Map<string, WorkerHandler>();
  const caches = new FakeCacheStorage(legacyCache);
  let skipWaitingCalls = 0;
  const worker = {
    location: { origin: 'https://radian.test' },
    addEventListener(type: string, handler: WorkerHandler) {
      handlers.set(type, handler);
    },
    clients: { claim: () => undefined },
    skipWaiting: () => { skipWaitingCalls += 1; },
  };

  const precache = ['/', '/manifest.webmanifest', '/icon.svg', '/exercises/individual/incline-press.webp'];
  runInNewContext(readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8').replace('"__PRECACHE_MANIFEST__"', JSON.stringify(precache)), {
    URL,
    caches,
    fetch: async (request: string | WorkerRequest) => responseFor(typeof request === 'string' ? request : new URL(request.url).pathname),
    self: worker,
  });

  return { handlers, caches, skipWaitingCalls: () => skipWaitingCalls };
};

describe('service worker', () => {
  it('sirve la navegación desde el shell canónico sin redirección', async () => {
    const { handlers, skipWaitingCalls } = loadWorker();
    let installPromise: Promise<unknown> | undefined;
    handlers.get('install')?.({ waitUntil: (promise) => { installPromise = promise; } });
    await installPromise;
    expect(skipWaitingCalls()).toBe(0);

    let responsePromise: Promise<WorkerResponse> | undefined;
    handlers.get('fetch')?.({
      request: { method: 'GET', mode: 'navigate', url: 'https://radian.test/' },
      respondWith: (promise) => { responsePromise = promise; },
    });

    const response = await responsePromise;
    expect(response?.redirected).toBe(false);
    await expect(response?.text()).resolves.toContain('/assets/app.js');
  });

  it('activa automáticamente la corrección cuando detecta un shell anterior en la raíz', async () => {
    const legacyCache = new FakeCache();
    legacyCache.set('/', responseFor('/'));
    const { handlers, skipWaitingCalls } = loadWorker(legacyCache);
    let installPromise: Promise<unknown> | undefined;
    handlers.get('install')?.({ waitUntil: (promise) => { installPromise = promise; } });
    await installPromise;

    expect(skipWaitingCalls()).toBe(1);
  });

  it('mantiene el aviso de actualización para un shell que ya conoce la PWA', async () => {
    const legacyCache = new FakeCache();
    legacyCache.set('/', responseFor('/', currentHtml));
    const { handlers, skipWaitingCalls } = loadWorker(legacyCache);
    let installPromise: Promise<unknown> | undefined;
    handlers.get('install')?.({ waitUntil: (promise) => { installPromise = promise; } });
    await installPromise;

    expect(skipWaitingCalls()).toBe(0);
  });
});

describe('precarga generada en build', () => {
  const buildFixture = (): { dir: string; cleanup: () => void } => {
    const dir = mkdtempSync(join(tmpdir(), 'radian-precache-'));
    mkdirSync(join(dir, 'assets'));
    mkdirSync(join(dir, 'exercises', 'individual'), { recursive: true });
    writeFileSync(join(dir, 'index.html'), '');
    writeFileSync(join(dir, 'assets', 'app-B3xj5a1.js'), '');
    writeFileSync(join(dir, 'assets', 'index-DcQ3-j_f.css'), '');
    writeFileSync(join(dir, 'exercises', 'individual', 'biceps-curl.webp'), '');
    writeFileSync(join(dir, 'exercises', 'atlas-push.png'), '');
    writeFileSync(join(dir, 'icon.svg'), '');
    writeFileSync(join(dir, 'manifest.webmanifest'), '');
    writeFileSync(join(dir, '_headers'), '');
    writeFileSync(join(dir, '_redirects'), '');
    writeFileSync(join(dir, 'sw.js'), '');
    return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  };

  it('incluye los assets emitidos y los ficheros públicos y excluye los ficheros de plataforma', () => {
    const { dir, cleanup } = buildFixture();
    try {
      const { precache, excluded } = buildPrecacheManifest(dir);

      expect(precache[0]).toBe('/');
      expect(precache).toContain('/assets/app-B3xj5a1.js');
      expect(precache).toContain('/assets/index-DcQ3-j_f.css');
      expect(precache).toContain('/exercises/individual/biceps-curl.webp');
      expect(precache).toContain('/manifest.webmanifest');
      expect(precache).toContain('/icon.svg');
      for (const path of precache) {
        expect(path.startsWith('/_headers')).toBe(false);
        expect(path.startsWith('/_redirects')).toBe(false);
        expect(path).not.toBe('/index.html');
        expect(path).not.toBe('/sw.js');
      }
      expect(excluded.sort()).toEqual(['_headers', '_redirects', 'exercises/atlas-push.png', 'index.html', 'sw.js']);
    } finally {
      cleanup();
    }
  });

  it('deja fuera del shell los duplicados legacy de los atlas en PNG', () => {
    const { dir, cleanup } = buildFixture();
    try {
      const { precache, excluded } = buildPrecacheManifest(dir);

      expect(precache).not.toContain('/exercises/atlas-push.png');
      expect(excluded).toContain('exercises/atlas-push.png');
    } finally {
      cleanup();
    }
  });
});
