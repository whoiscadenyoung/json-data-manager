import { Moon, Sun, SunMoon } from "lucide-react";
import { useEffect, useSyncExternalStore } from "react";

import { buttonVariants } from "#/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";

type ThemeMode = "light" | "dark" | "auto";

function getInitialMode(): ThemeMode {
  if (typeof window === "undefined") {
    return "auto";
  }

  const stored = window.localStorage.getItem("theme");
  if (stored === "light" || stored === "dark" || stored === "auto") {
    return stored;
  }

  return "auto";
}

function applyThemeMode(mode: ThemeMode) {
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches,
    resolved = mode === "auto" ? (prefersDark ? "dark" : "light") : mode;

  document.documentElement.classList.remove("light", "dark");
  document.documentElement.classList.add(resolved);

  if (mode === "auto") {
    delete document.documentElement.dataset.theme;
  } else {
    document.documentElement.dataset.theme = mode;
  }

  document.documentElement.style.colorScheme = resolved;
}

// Minimal external store so the toggle reads the persisted theme without a
// mount effect (the DOM theme itself is applied by the inline script in the
// root document, so we only track the value here).
const themeListeners = new Set<() => void>();

function subscribeTheme(callback: () => void) {
  themeListeners.add(callback);
  window.addEventListener("storage", callback);
  return () => {
    themeListeners.delete(callback);
    window.removeEventListener("storage", callback);
  };
}

function setStoredTheme(mode: ThemeMode) {
  window.localStorage.setItem("theme", mode);
  applyThemeMode(mode);
  for (const listener of themeListeners) {
    listener();
  }
}

function getServerTheme(): ThemeMode {
  return "auto";
}

export function ThemeToggle() {
  const mode = useSyncExternalStore(subscribeTheme, getInitialMode, getServerTheme);

  useEffect(() => {
    if (mode !== "auto") {
      return undefined;
    }

    const media = window.matchMedia("(prefers-color-scheme: dark)"),
      onChange = () => {
        applyThemeMode("auto");
      };

    media.addEventListener("change", onChange);
    return () => {
      media.removeEventListener("change", onChange);
    };
  }, [mode]);

  function selectMode(next: ThemeMode) {
    setStoredTheme(next);
  }

  const Icon = mode === "light" ? Sun : mode === "dark" ? Moon : SunMoon;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={buttonVariants({ size: "icon", variant: "ghost" })}
        aria-label={`Theme: ${mode}`}
      >
        <Icon className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          onClick={() => {
            selectMode("auto");
          }}
        >
          <SunMoon className="mr-2 size-4" />
          Auto
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => {
            selectMode("light");
          }}
        >
          <Sun className="mr-2 size-4" />
          Light
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => {
            selectMode("dark");
          }}
        >
          <Moon className="mr-2 size-4" />
          Dark
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
