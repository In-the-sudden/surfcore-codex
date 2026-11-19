export function enforceQuota(rateLimits, policy, now = Date.now()) {
  if (!policy.enabled) return;
  for (const [key, threshold] of [['primary', policy.primaryRemaining], ['secondary', policy.secondaryRemaining]]) {
    const window = rateLimits?.[key];
    if (!window || !Number.isFinite(window.usedPercent) || window.usedPercent < 0 || window.usedPercent > 100 || !Number.isFinite(window.resetsAt) || window.resetsAt * 1000 <= now)
      throw new Error('无法读取有效的账号额度，已按百分比保护设置暂停新调用。');
    if (100 - window.usedPercent <= threshold) throw new Error('Codex ' + (key === 'primary' ? '短周期' : '长周期') + '剩余额度已到保留阈值，暂停新调用。');
  }
}
