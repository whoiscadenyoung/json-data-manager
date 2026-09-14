import { createFileRoute } from "@tanstack/react-router";

import { RouterButton } from "#/components/router-button";

export const Route = createFileRoute("/")({ component: HomePage });

function HomePage() {
  return (
    <main className="flex items-center justify-center gap-3 min-h-[calc(100vh-4rem)]">
      <RouterButton to="/datasets" size="lg">
        View Datasets
      </RouterButton>
      <RouterButton to="/collections" size="lg" variant="outline">
        View Collections
      </RouterButton>
    </main>
  );
}
