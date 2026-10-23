import { build } from './app.js';
import { migrate, seed } from './db.js';
const app = build();
const PORT = +process.env.PORT || 48333;
await migrate(); await seed();
app.listen({ host: '127.0.0.1', port: PORT })
  .then(() => console.log(`Cardinar backend (Fastify+PG) на http://127.0.0.1:${PORT}`))
  .catch(e => { console.error(e); process.exit(1); });
