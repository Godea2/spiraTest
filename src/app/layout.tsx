import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Spira Test Set Reconciler", template: "%s · Spira Test Set Reconciler" },
  description: "Reconcile Spira test sets against the release scope workbook.",
  robots: { index: false, follow: false },
};

const themeScript = `(function(){try{var t=localStorage.getItem("theme");var d=t?t==="dark":window.matchMedia("(prefers-color-scheme: dark)").matches;if(d)document.documentElement.classList.add("dark")}catch(e){}})()`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-dvh">{children}</body>
    </html>
  );
}
