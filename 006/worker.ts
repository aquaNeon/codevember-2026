import { host, type In, type Out } from "./host";

// WORKER
const scope = self as unknown as {
  postMessage(m: Out): void;
  onmessage: ((e: MessageEvent<In>) => void) | null;
};
const handle = host((m) => scope.postMessage(m));
scope.onmessage = (e) => handle(e.data);
