import { config } from "./config";
import { generateDeployments } from "./generate";
import { startServer } from "./server";
import { DeploymentStore } from "./store";

const store = new DeploymentStore(config.dbPath);
if (store.countLayer("centroids") === 0) {
  store.reset(generateDeployments(config.count, config.seed));
}

const server = startServer({
  fixture: { count: config.count, seed: config.seed },
  port: config.port,
  publicUrl: config.publicUrl,
  store,
  token: config.token,
});

console.log(
  `deploy-source demo on ${server.url.href} — ${store.countLayer("centroids")} deployments, ${store.countLayer("routes")} routes`,
);
