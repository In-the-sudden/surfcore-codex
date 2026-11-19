import { launchCodex } from './codex.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
let pending;
export function accountStatus() {
  if (pending) return pending;
  pending = readStatus().finally(() => { pending = undefined; });
  return pending;
}
export async function readStatus({ launch = launchCodex } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'surfcore-account-'));
  let server;
  try {
    server = launch(cwd);
    await server.initialize();
    const account = await server.request('account/read', { refreshToken: false });
    const config = await server.request('config/read', { includeLayers: false });
    let rateLimits = null, quotaError = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        rateLimits = (await server.request('account/rateLimits/read'))?.rateLimits ?? null;
        if (rateLimits) break;
      } catch {}
    }
    if (!rateLimits) quotaError = '暂时无法读取账号额度，请检查登录和网络后刷新。';
    const clean = (value) => value && Number.isFinite(value.usedPercent) && value.usedPercent >= 0 && value.usedPercent <= 100
      && Number.isFinite(value.resetsAt) && Number.isFinite(value.windowDurationMins)
      ? { usedPercent: value.usedPercent, windowDurationMins: value.windowDurationMins, resetsAt: value.resetsAt } : null;
    return { at: new Date().toISOString(), accountType: account.account?.type ?? null, plan: account.account?.planType ?? null,
      model: config.config?.model ?? '宿主默认', provider: config.config?.model_provider ?? '默认',
      rateLimits: rateLimits ? { primary: clean(rateLimits.primary), secondary: clean(rateLimits.secondary) } : null, quotaError };
  } finally {
    server?.close();
    if (dirname(resolve(cwd)) === resolve(tmpdir())) await rm(cwd, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 });
  }
}
