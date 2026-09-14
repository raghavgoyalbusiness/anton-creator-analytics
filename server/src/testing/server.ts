import type { Express } from 'express';
import type { AddressInfo } from 'node:net';
import { createServer, type Server } from 'node:http';

/**
 * A test server bound to 127.0.0.1, already listening.
 *
 * Why every route test goes through this instead of handing supertest the
 * Express app directly:
 *
 * Given an app, supertest calls `listen(0)` for each request and connects to
 * 127.0.0.1. With no host, Node binds the IPv6 wildcard `::` — and macOS lets
 * that bind succeed even when ANOTHER process already holds the same port on
 * 127.0.0.1. When the OS handed out one of those ports, the test's request went
 * to the other process instead of to Anton.
 *
 * On the machine this was found on, a Logitech plugin service was listening on
 * three ports in the ephemeral range. The symptom was an HTTP 501 with an empty
 * body on a random POST, or a socket hang-up on a random GET, in a random test
 * file, roughly once in five full runs — never reproducible in isolation, and
 * with no trace of the request in Anton's own server. Proven directly: bind
 * [::]:60539 while Logitech holds 127.0.0.1:60539, POST to 127.0.0.1:60539, and
 * the reply is `501 ""`.
 *
 * Binding 127.0.0.1 explicitly means the OS can only hand out a port that is
 * genuinely free on the address the client connects to. It cannot be patched
 * in globally: an explicit host makes `listen` resolve the address
 * asynchronously, and supertest reads the port synchronously right after its
 * own `listen(0)`. So the server is started once per file, awaited, and passed
 * to supertest already listening — at which point supertest never listens
 * itself.
 */
export async function listenForTests(app: Express): Promise<Server> {
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;
  if (address.address !== '127.0.0.1') {
    throw new Error(`test server bound ${address.address}, expected 127.0.0.1`);
  }
  return server;
}

export async function closeTestServer(server: Server | undefined): Promise<void> {
  if (!server?.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
