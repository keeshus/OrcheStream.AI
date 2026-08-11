import { cn } from '@/lib/utils';

export function BetaBadge({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full bg-secondary-container px-2 py-0.5 m3-label-small text-on-secondary-container align-middle',
        className,
      )}
    >
      Beta
    </span>
  );
}
