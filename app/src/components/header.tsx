import { Link } from "@tanstack/react-router";

import { ThemeToggle } from "./theme-toggle";

export function Header() {
  return (
    <header className="sticky top-0 z-50 border-b bg-background/80 px-6 backdrop-blur-lg">
      <div className="flex h-14 items-center justify-between">
        <div className="flex items-center gap-6">
          <Link to="/" className="text-sm font-semibold">
            JSON Data Manager
          </Link>
          <nav className="flex items-center gap-4 text-sm text-muted-foreground">
            <Link
              to="/datasets"
              className="hover:text-foreground"
              activeProps={{ className: "text-foreground" }}
            >
              Datasets
            </Link>
            <Link
              to="/collections"
              className="hover:text-foreground"
              activeProps={{ className: "text-foreground" }}
            >
              Collections
            </Link>
            <Link
              to="/maps"
              className="hover:text-foreground"
              activeProps={{ className: "text-foreground" }}
            >
              Maps
            </Link>
          </nav>
        </div>
        <ThemeToggle />
      </div>
    </header>
  );
}
