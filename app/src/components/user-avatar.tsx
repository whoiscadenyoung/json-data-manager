import { cn } from "#/lib/utils";

/**
 * A user's avatar: their Better Auth image when set, otherwise their
 * initials on a muted disc. Sized by the caller via `className` (the img
 * and the fallback both fill the box).
 */
export function UserAvatar({
  className,
  image,
  name,
}: {
  className?: string;
  image?: string;
  name?: string;
}) {
  const initials =
    name === undefined || name.trim() === ""
      ? "?"
      : name
          .trim()
          .split(/\s+/)
          .slice(0, 2)
          .map((part) => part[0].toUpperCase())
          .join("");
  return (
    <span className={cn("relative flex shrink-0 overflow-hidden rounded-full bg-muted", className)}>
      {image !== undefined ? (
        <img src={image} alt="" className="aspect-square h-full w-full object-cover" />
      ) : (
        <span className="flex h-full w-full items-center justify-center font-medium text-muted-foreground">
          {initials}
        </span>
      )}
    </span>
  );
}
