import { createFileRoute } from "@tanstack/react-router";

import { RouterButton } from "#/components/router-button";

export const Route = createFileRoute("/")({ component: HomePage });

function HomePage() {
  return (
    <main className="flex items-center justify-center min-h-[calc(100vh-4rem)]">
      <RouterButton to="/datasets" size="lg">
        View Datasets
      </RouterButton>
    </main>
  );
}
