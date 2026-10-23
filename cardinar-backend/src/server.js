import { build } from './app.js';
import { migrate, seed } from './db.js';
const app = build();
const PORT = +process.env.PORT || 48333;
const HOST = process.env.HOST || '0.0.0.0';
await migrate(); await seed();
app.listen({ host: HOST, port: PORT })
  .then(() => console.log(`Cardinar backend (Fastify+PG) на http://${HOST}:${PORT}`))
  .catch(e => { console.error(e); process.exit(1); });
