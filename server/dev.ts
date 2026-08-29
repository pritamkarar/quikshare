import { buildServer, resolvePort } from './index.js';

const app = await buildServer();
const port = resolvePort(process.env.PORT);
await app.listen({ port, host: '127.0.0.1' });
// eslint-disable-next-line no-console
console.log(`Quik Share dev server on http://127.0.0.1:${port}`);
