import assert from 'node:assert/strict';
import { afterEach, test } from 'vitest';
import type { DeviceLease } from '@agent-device/contracts/device';
import { AppError } from '@agent-device/kernel/errors';
import { createCloudWebDriverRuntime, type CloudWebDriverRuntimeOptions } from './runtime.ts';
import { consumeAllProfileFields } from './profile-fields.fixtures.ts';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

test('session allocation preserves its primary failure when provider cleanup also fails', async () => {
  let cleanupCalled = false;
  globalThis.fetch = async () => jsonResponse({ value: { message: 'create session failed' } }, 500);
  const runtime = makeRuntime({
    prepareSession: async ({ base }) => ({
      ...base,
      cleanup: async () => {
        cleanupCalled = true;
        throw new Error('provider cleanup failed');
      },
    }),
  });

  try {
    await assert.rejects(
      () => runtime.leaseLifecycle.allocate!(makeLease()),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.match(error.message, /create session failed/);
        assert.equal(error.details?.cleanupError, 'provider cleanup failed');
        return true;
      },
    );
    assert.equal(cleanupCalled, true);
  } finally {
    await runtime.shutdown();
  }
});

// #1774: when the transport gives up on `POST /session`, the provider may still
// finish it. The error names the lease the capabilities were labelled with so
// an operator can find and stop the maybe-orphaned billed session, rather than
// this process guessing at REST cleanup of a session it never owned.
test('a create-timeout surfaces provider evidence for the maybe-leaked session', async () => {
  globalThis.fetch = async (_input, init) =>
    await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason as Error));
    });
  const runtime = makeRuntime({
    provider: 'browserstack',
    platform: 'ios',
    requestPolicy: { retryAttempts: 0, sessionCreateTimeoutMs: 40 },
  });
  const lease = { ...makeLease(), leaseProvider: 'browserstack' };

  try {
    await assert.rejects(
      () => runtime.leaseLifecycle.allocate!(lease),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.details?.reason, 'provider_session_create_timeout');
        assert.equal(error.details?.provider, 'browserstack');
        assert.equal(error.details?.leaseId, lease.leaseId);
        assert.match(String(error.details?.hint), new RegExp(lease.leaseId));
        return true;
      },
    );
  } finally {
    await runtime.shutdown();
  }
});

/**
 * `DELETE /session/{id}` is idempotent: one transient hub failure is retried rather than left as a
 * billed session, and a hub that no longer knows the session (`invalid session id`) has ended it.
 */
test.each([
  ['a transient delete failure is retried', 502, '<html>Bad Gateway</html>'],
  [
    'a delete answered invalid session id',
    404,
    JSON.stringify({ value: { error: 'invalid session id', message: 'session not found' } }),
  ],
] as const)('%s confirms the release', async (_name, status, body) => {
  const deletes: number[] = [];
  globalThis.fetch = async (input, init) => {
    const method = init?.method ?? new Request(input as RequestInfo).method;
    if (method !== 'DELETE') return jsonResponse({ sessionId: 'session-1', capabilities: {} });
    deletes.push(deletes.length);
    return deletes.length === 1 ? new Response(body, { status }) : jsonResponse({ value: null });
  };
  const runtime = makeRuntime({ requestPolicy: { retryAttempts: 1, retryDelayMs: 1 } });
  const lease = makeLease();

  try {
    await runtime.leaseLifecycle.allocate!(lease);
    assert.deepEqual(await runtime.leaseLifecycle.release!(lease), {
      provider: 'webdriver-test',
      providerSessionId: 'session-1',
    });
  } finally {
    await runtime.shutdown();
  }
});

test('cloud artifact lookup does not accept a provider session id without its lease', async () => {
  let listCalls = 0;
  const runtime = makeRuntime({
    listArtifacts: async () => {
      listCalls += 1;
      return {
        provider: 'webdriver-test',
        status: 'ready',
        cloudArtifacts: [],
      };
    },
  });

  try {
    const cloudArtifacts = runtime.cloudArtifacts;
    assert.ok(cloudArtifacts);
    const result = await cloudArtifacts.listCloudArtifacts?.({
      provider: 'webdriver-test',
      providerSessionId: 'never-authorized',
    });
    assert.equal(result, undefined);
    assert.equal(listCalls, 0);
  } finally {
    await runtime.shutdown();
  }
});

test('rejects sessionOwnership=attached without existingSessionId before POST /session and runs cleanup', async () => {
  let fetchCalls = 0;
  let cleanupCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return jsonResponse({ sessionId: 'should-not-create', capabilities: {} });
  };
  const runtime = makeRuntime({
    sessionOwnership: 'attached',
    prepareSession: async ({ base }) => ({
      ...base,
      cleanup: async () => {
        cleanupCalls += 1;
        return undefined;
      },
    }),
  });

  try {
    await assert.rejects(
      () => runtime.leaseLifecycle.allocate!(makeLease()),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.code, 'INVALID_ARGS');
        return true;
      },
    );
    assert.equal(fetchCalls, 0);
    assert.equal(cleanupCalls, 1);
  } finally {
    await runtime.shutdown();
  }
});

test('created session is always owned and sends DELETE /session/{id} on release', async () => {
  const requests: string[] = [];
  globalThis.fetch = async (input, init) => {
    const method = init?.method ?? new Request(input as RequestInfo).method;
    const pathname = new URL(String(input instanceof Request ? input.url : input)).pathname;
    requests.push(`${method} ${pathname}`);
    if (method === 'POST' && pathname.endsWith('/session')) {
      return jsonResponse({ value: { sessionId: 'created-1', capabilities: {} } });
    }
    if (method === 'DELETE' && pathname.endsWith('/session/created-1')) {
      return jsonResponse({ value: null });
    }
    return jsonResponse({ value: null });
  };
  const runtime = makeRuntime();
  const lease = makeLease();

  try {
    await runtime.leaseLifecycle.allocate!(lease);
    await runtime.leaseLifecycle.release!(lease);
  } finally {
    await runtime.shutdown();
  }

  assert.deepEqual(requests, ['POST /wd/hub/session', 'DELETE /wd/hub/session/created-1']);
});

test('rejects guardedWdaTap with unguarded routeProfile or non-ios platform before create', async () => {
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return jsonResponse({ value: { sessionId: 'unexpected', capabilities: {} } });
  };

  assert.throws(
    () =>
      makeRuntime({
        platform: 'ios',
        routeProfile: 'appium',
        guardedWdaTap: async () => {},
      }),
    (error: unknown) => error instanceof AppError && error.code === 'INVALID_ARGS',
  );

  assert.throws(
    () =>
      makeRuntime({
        platform: 'android',
        routeProfile: 'wda',
        guardedWdaTap: async () => {},
      }),
    (error: unknown) => error instanceof AppError && error.code === 'INVALID_ARGS',
  );

  const dynamicRuntime = makeRuntime({
    platform: 'ios',
    routeProfile: 'wda',
    guardedWdaTap: async () => {},
    prepareSession: async ({ base }) => ({ ...base, routeProfile: 'appium' }),
  });
  try {
    await assert.rejects(
      () => dynamicRuntime.leaseLifecycle.allocate!(makeLease()),
      (error: unknown) => error instanceof AppError && error.code === 'INVALID_ARGS',
    );
    assert.equal(fetchCalls, 0);
  } finally {
    await dynamicRuntime.shutdown();
  }
});

test('enforces single active attached lease across concurrent allocations and allows post-release reallocation', async () => {
  globalThis.fetch = async (input) => {
    const pathname = new URL(String(input instanceof Request ? input.url : input)).pathname;
    if (pathname.endsWith('/wda/activeAppInfo')) {
      return jsonResponse({ value: { bundleId: 'com.example.app' } });
    }
    return jsonResponse({ value: { message: 'unexpected' } }, 404);
  };
  const guardedLeaseIds: string[] = [];
  const runtime = makeRuntime({
    platform: 'ios',
    routeProfile: 'wda',
    existingSessionId: 'SESS-SHARED',
    sessionOwnership: 'attached',
    deviceId: () => 'UDID-SHARED',
    guardedWdaTap: async (request) => {
      if (request.leaseId) guardedLeaseIds.push(request.leaseId);
    },
  });
  const leaseA = { ...makeLease(), leaseId: 'lease-a' };
  const leaseB = { ...makeLease(), leaseId: 'lease-b' };
  const device = {
    platform: 'apple' as const,
    target: 'mobile' as const,
    appleOs: 'ios' as const,
    id: 'UDID-SHARED',
    name: 'Attached iOS',
    kind: 'device' as const,
    booted: true,
  };

  try {
    const [resA, resB] = await Promise.allSettled([
      runtime.leaseLifecycle.allocate!(leaseA),
      runtime.leaseLifecycle.allocate!(leaseB),
    ]);
    const fulfilled = [resA, resB].filter((r) => r.status === 'fulfilled');
    const rejected = [resA, resB].filter((r) => r.status === 'rejected');
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.ok(rejected[0]!.reason instanceof AppError);
    assert.equal((rejected[0]!.reason as AppError).code, 'DEVICE_IN_USE');

    const winnerLease = resA.status === 'fulfilled' ? leaseA : leaseB;
    const loserLease = resA.status === 'fulfilled' ? leaseB : leaseA;
    await assert.rejects(
      () => runtime.leaseLifecycle.allocate!(loserLease),
      (error: unknown) => error instanceof AppError && error.code === 'DEVICE_IN_USE',
    );
    await runtime.getInteractor(device)!.tap(10, 20);
    await runtime.leaseLifecycle.release!(winnerLease);

    await runtime.leaseLifecycle.allocate!(loserLease);
    await runtime.getInteractor(device)!.tap(30, 40);
    assert.deepEqual(guardedLeaseIds, [winnerLease.leaseId, loserLease.leaseId]);
  } finally {
    await runtime.shutdown();
  }
});

function makeRuntime(overrides: Partial<CloudWebDriverRuntimeOptions> = {}) {
  return createCloudWebDriverRuntime({
    clientVersion: 'test',
    provider: 'webdriver-test',
    endpoint: 'https://webdriver.test/wd/hub/',
    platform: 'android',
    deviceName: 'Test device',
    profileFields: consumeAllProfileFields('webdriver-test'),
    requestPolicy: { retryAttempts: 0 },
    ...overrides,
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeLease(): DeviceLease {
  return {
    leaseId: 'lease-1',
    tenantId: 'team-a',
    runId: 'run-a',
    clientId: 'client-a',
    leaseProvider: 'webdriver-test',
    backend: 'android-instance',
    deviceKey: 'webdriver-test:device-a',
    createdAt: 1,
    expiresAt: 2,
    heartbeatAt: 1,
  };
}
