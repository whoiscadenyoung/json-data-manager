import { buttonVariants } from "@caden/ui/components/button";
import { cn } from "@caden/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import type { LinkProps } from "@tanstack/react-router";
import type { VariantProps } from "class-variance-authority";

type RouterButtonProps = LinkProps &
  VariantProps<typeof buttonVariants> & {
    className?: string;
    children?: React.ReactNode;
  };

function RouterButton({ className, variant, size, children, ...props }: RouterButtonProps) {
  return (
    <Link className={cn(buttonVariants({ className, size, variant }))} {...props}>
      {children}
    </Link>
  );
}

export { RouterButton };
