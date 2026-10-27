import { config } from "./config";
import { generateDeployments } from "./generate";
import { DeploymentStore } from "./store";

// `bun run seed` — wipes and regenerates the fixture. Safe while the server
// runs (SQLite WAL); both layer revisions bump, so json-data-manager sees
// the reseed as an available update.
const store = new DeploymentStore(config.dbPath);
store.reset(generateDeployments(config.count, config.seed));
console.log(
  `Seeded ${store.countLayer("centroids")} deployments (${store.countLayer("routes")} with routes) into ${config.dbPath}`,
);
store.close();
