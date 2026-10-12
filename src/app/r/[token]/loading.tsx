import { Spinner } from "@/components/ui";

export default function Loading() {
  return (
    <main className="grid min-h-dvh place-items-center bg-slate-100 px-4 text-slate-900">
      <div className="flex flex-col items-center gap-3 text-center">
        <Spinner />
        <p className="text-sm font-medium">Preparing the report</p>
        <p className="text-xs text-slate-500">Reading the latest results from Spira. This takes a few seconds.</p>
      </div>
    </main>
  );
}
