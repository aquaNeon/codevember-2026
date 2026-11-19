import { host, type In, type Out } from "./host";

// WORKER
// the gpu start-up and every frame happen here, off the page's main thread
const scope = self as unknown as {
  postMessage(m: Out): void;
  onmessage: ((e: MessageEvent<In>) => void) | null;
};
const handle = host((m) => scope.postMessage(m));
scope.onmessage = (e) => handle(e.data);
