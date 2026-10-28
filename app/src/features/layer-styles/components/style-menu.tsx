import { Button } from "@caden/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@caden/ui/components/dropdown-menu";
import { Ellipsis, Palette, RotateCcw } from "lucide-react";

/**
 * The styling module's only footprint in the layer panel: a `⋯` menu on a
 * dataset row with **Style…** (and **Reset style** once one is saved). A
 * small dot on the button marks a styled dataset.
 */
export function StyleMenu({
  title,
  styled,
  onEdit,
  onReset,
}: {
  title: string;
  styled: boolean;
  onEdit: () => void;
  onReset: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            className="relative size-7"
            aria-label={`More actions for "${title}"`}
          />
        }
      >
        <Ellipsis className="size-3.5" />
        {styled && (
          <span
            aria-hidden
            className="absolute top-1 right-1 inline-block size-1.5 rounded-full bg-primary"
          />
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuItem onClick={onEdit}>
          <Palette className="size-4" />
          Style…
        </DropdownMenuItem>
        {styled && (
          <DropdownMenuItem onClick={onReset}>
            <RotateCcw className="size-4" />
            Reset style
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
