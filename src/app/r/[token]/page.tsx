import { Clock, FileChartColumn, LinkIcon, type LucideIcon } from "lucide-react";
import type { Metadata } from "next";
import { ReportDocument } from "@/app/(app)/reports/report-document";
import { reportFileName, type Report } from "@/lib/domain/report";
import { readLiveReport } from "@/lib/server/report-live";
import { readShareToken } from "@/lib/server/report-share";
import { SharedReport } from "./shared-report";

export const maxDuration = 120;

type Props = { params: Promise<{ token: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const share = readShareToken((await params).token);
  return {
    title: { absolute: share.ok ? share.options.title.trim() || "Test report" : "Report link" },
    referrer: "no-referrer",
    robots: { index: false, follow: false },
  };
}

function Message({ icon: Icon, title, children }: { icon: LucideIcon; title: string; children: string }) {
  return (
    <main className="grid min-h-dvh place-items-center bg-slate-100 px-4 text-slate-900">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
        <span className="mx-auto grid size-12 place-items-center rounded-2xl bg-slate-100 text-slate-500">
          <Icon className="size-6" aria-hidden />
        </span>
        <h1 className="mt-4 text-lg font-semibold tracking-tight">{title}</h1>
        <p className="mt-2 text-sm leading-relaxed text-slate-600">{children}</p>
      </div>
    </main>
  );
}

/** A report shared by link: no sign-in, read live from Spira on the server, and only this report. */
export default async function SharedReportPage({ params }: Props) {
  const share = readShareToken((await params).token);
  if (!share.ok) {
    return share.reason === "expired" ? (
      <Message icon={Clock} title="This report link has expired">
        Ask the person who shared it for a new link.
      </Message>
    ) : (
      <Message icon={LinkIcon} title="This report link is not valid">
        It may have been cut short when it was copied. Ask the person who shared it to send it again.
      </Message>
    );
  }

  let report: Report | null = null;
  try {
    report = await readLiveReport(share.projectId, share.options, share.mappings);
  } catch (error) {
    console.error("A shared report could not be read from Spira", error);
  }
  if (!report) {
    return (
      <Message icon={FileChartColumn} title="The report could not be read right now">
        Spira did not answer in time. Try again in a few minutes.
      </Message>
    );
  }

  return (
    <SharedReport title={report.title} project={report.projectName} generatedAt={report.generatedAt} expiresAt={share.expiresAt} fileName={reportFileName(report)}>
      <ReportDocument report={report} changes={null} siteUrl={null} />
    </SharedReport>
  );
}
