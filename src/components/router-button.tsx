import { Link, type LinkProps } from '@tanstack/react-router'
import { type VariantProps } from 'class-variance-authority'

import { buttonVariants } from '#/components/ui/button'
import { cn } from '#/lib/utils'

type RouterButtonProps = LinkProps &
  VariantProps<typeof buttonVariants> & {
    className?: string
    children?: React.ReactNode
  }

function RouterButton({ className, variant, size, children, ...props }: RouterButtonProps) {
  return (
    <Link className={cn(buttonVariants({ variant, size, className }))} {...props}>
      {children}
    </Link>
  )
}

export { RouterButton }
