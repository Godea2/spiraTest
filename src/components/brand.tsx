import clsx from "clsx";
import { Layers3 } from "lucide-react";

/** The app mark: a gradient tile with the stacked-sets glyph. */
export function Logo({ size = "md" }: { size?: "md" | "lg" }) {
  return (
    <span
      className={clsx(
        "relative grid shrink-0 place-items-center rounded-xl bg-gradient-to-br from-brand-500 via-violet-500 to-fuchsia-500 text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.25),0_6px_16px_-6px_rgb(99_102_241/0.7)]",
        size === "lg" ? "size-12 rounded-2xl" : "size-8",
      )}
      aria-hidden
    >
      <Layers3 className={size === "lg" ? "size-6" : "size-[18px]"} strokeWidth={2.2} />
    </span>
  );
}
