import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cn } from '../../lib/utils'

type ButtonVariant = 'default' | 'destructive' | 'outline' | 'secondary' | 'ghost' | 'link'
type ButtonSize = 'default' | 'sm' | 'lg' | 'icon' | 'icon-sm' | 'icon-lg'

const variantClasses: Record<ButtonVariant, string> = {
  default: 'bg-accent text-white hover:bg-accent-hover',
  destructive: 'bg-destructive text-white hover:bg-destructive/90',
  outline: 'border bg-background hover:bg-accent hover:text-accent-foreground',
  secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
  ghost: 'hover:bg-accent hover:text-accent-foreground',
  link: 'text-primary underline-offset-4 hover:underline',
}

const sizeClasses: Record<ButtonSize, string> = {
  default: 'h-9 px-4 py-2',
  sm: 'h-8 rounded-md px-3',
  lg: 'h-10 rounded-md px-6',
  icon: 'size-9',
  'icon-sm': 'size-8',
  'icon-lg': 'size-10',
}

interface ButtonProps extends React.ComponentProps<'button'> {
  variant?: ButtonVariant
  size?: ButtonSize
  asChild?: boolean
}

function Button({
  className,
  variant = 'default',
  size = 'default',
  asChild = false,
  ...props
}: ButtonProps) {
  const Comp = asChild ? Slot : 'button'

  return (
    <Comp
      data-slot="button"
      className={cn(
        'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-all disabled:pointer-events-none disabled:opacity-50 outline-none focus-visible:ring-2 shrink-0',
        variantClasses[variant],
        sizeClasses[size],
        className,
      )}
      {...props}
    />
  )
}

export { Button }
export type { ButtonProps }
