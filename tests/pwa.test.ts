import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

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

const responseFor = (path: string): WorkerResponse => ({
  ok: true,
  redirected: path === '/index.html',
  type: 'basic',
  text: async () => html,
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

  runInNewContext(readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8'), {
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

  it('activa automáticamente la corrección cuando detecta un shell redirigido anterior', async () => {
    const legacyCache = new FakeCache();
    legacyCache.set('/index.html', responseFor('/index.html'));
    const { handlers, skipWaitingCalls } = loadWorker(legacyCache);
    let installPromise: Promise<unknown> | undefined;
    handlers.get('install')?.({ waitUntil: (promise) => { installPromise = promise; } });
    await installPromise;

    expect(skipWaitingCalls()).toBe(1);
  });
});
