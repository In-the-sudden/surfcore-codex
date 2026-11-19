export function createGroupBurstCollector({
  process,
  scheduleTimer = setTimeout,
  cancelTimer = clearTimeout,
  now = () => performance.now(),
  idleMs = 1_500,
  maxMs = 4_000,
}) {
  const groups = new Map();

  async function run(records, context) {
    return process(records, context);
  }

  function finish(burst, discard = false) {
    groups.delete(burst.contact);
    cancelTimer(burst.timer);
    burst.resolve(discard ? null : run(burst.records, burst.context));
  }

  function add(incoming, { mergeable = false, context } = {}) {
    if (incoming.kind !== 'group') return run([incoming], context);
    const { contact, senderId } = incoming;
    const time = now();
    let burst = groups.get(contact);
    if (burst && (
      !mergeable || burst.senderId !== senderId || time >= burst.deadline ||
      burst.context?.token !== context?.token || burst.context?.authGeneration !== context?.authGeneration
    )) {
      finish(burst);
      burst = null;
    }
    if (!mergeable) return run([incoming], context);

    if (burst) {
      cancelTimer(burst.timer);
    } else {
      const { promise, resolve } = Promise.withResolvers();
      burst = { contact, senderId, context, startedAt: time, records: [], promise, resolve };
      groups.set(contact, burst);
    }
    burst.records.push(incoming);
    burst.deadline = Math.min(time + idleMs, burst.startedAt + maxMs);
    const timer = scheduleTimer(() => {
      if (groups.get(contact) === burst && burst.timer === timer) finish(burst);
    }, burst.deadline - time);
    burst.timer = timer;
    return burst.promise;
  }

  function flush(contact) {
    if (contact === undefined) {
      for (const burst of [...groups.values()]) finish(burst);
      return;
    }
    const burst = groups.get(contact);
    if (burst) finish(burst);
  }

  function cancel() {
    for (const burst of groups.values()) finish(burst, true);
  }

  return { add, flush, cancel };
}
