import clsx from "clsx";
import { Layers3 } from "lucide-react";

/** The app mark: a solid tile with the stacked-sets glyph. */
export function Logo({ size = "md" }: { size?: "md" | "lg" }) {
  return (
    <span
      className={clsx(
        "relative grid shrink-0 place-items-center rounded-xl bg-slate-900 text-white dark:bg-white dark:text-slate-900",
        size === "lg" ? "size-12 rounded-2xl" : "size-8",
      )}
      aria-hidden
    >
      <Layers3 className={size === "lg" ? "size-6" : "size-[18px]"} strokeWidth={2.2} />
    </span>
  );
}
