type Pending = {
  resolve: (text: string) => void;
  reject: (err: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

const pending = new Map<string, Pending>();
const inbox = new Map<string, string>();

// TOTO CAKA NA POMOC OD POUZIVATELA
export function waitForHelp(runId: string, helpId: string, timeoutMs = 180_000): Promise<string> {
  const key = `${runId}:${helpId}`;

  const early = inbox.get(key);
  if (early != null) {
    inbox.delete(key);
    return Promise.resolve(early);
  }

  return new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(key);
      reject(new Error(`Help timeout (${timeoutMs}ms) for ${key}`));
    }, timeoutMs);

    pending.set(key, { resolve, reject, timeout });
  });
}

// TOTO ULOZI ODPOVED OD POUZIVATELA
export function provideHelp(runId: string, helpId: string, text: string) {
  const key = `${runId}:${helpId}`;
  const p = pending.get(key);

  if (!p) {
    inbox.set(key, text);
    return;
  }

  clearTimeout(p.timeout);
  pending.delete(key);
  p.resolve(text);
}

// TOTO ZRUSI VSETKY CAKAJUCE POMOCI PRE BEH
export function cancelPendingForRun(runId: string, reason = "Run finished before help was delivered") {
  const prefix = `${runId}:`;

  for (const [key, item] of pending.entries()) {
    if (!key.startsWith(prefix)) continue;
    clearTimeout(item.timeout);
    item.reject(new Error(reason));
    pending.delete(key);
  }

  for (const key of [...inbox.keys()]) {
    if (key.startsWith(prefix)) inbox.delete(key);
  }
}

export function countPendingForRun(runId: string) {
  const prefix = `${runId}:`;
  let count = 0;
  for (const key of pending.keys()) {
    if (key.startsWith(prefix)) count++;
  }
  return count;
}
