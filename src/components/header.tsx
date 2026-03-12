import { Link } from "@tanstack/react-router";
import ThemeToggle from "./theme-toggle";

export default function Header() {
  return (
    <header className="sticky top-0 z-50 border-b bg-background/80 px-6 backdrop-blur-lg">
      <div className="flex h-14 items-center justify-between">
        <Link to="/" className="text-sm font-semibold">
          JSON Data Manager
        </Link>
        <ThemeToggle />
      </div>
    </header>
  );
}
