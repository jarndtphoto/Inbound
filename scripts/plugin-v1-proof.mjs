import { createFixtureProofServer } from '../src/lib/plugin-v1/proof-server.ts';

// Explicit, local-only entry point. Never launched by app build/dev/deployment.
const { server } = createFixtureProofServer();
server.listen(3791, '127.0.0.1', () => {
  console.log('Inbound static fixture proof started; no live providers or production APIs.');
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
