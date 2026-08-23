import type { Metadata } from "next";
import { Inter, Poppins } from "next/font/google";
import "./globals.css";

import { Analytics } from "@vercel/analytics/react";

const inter = Inter({ subsets: ["latin"] });
const poppins = Poppins({ 
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
  variable: "--font-poppins"
});

export const metadata: Metadata = {
  title: "AI Meeting Copilot - Real-Time Answer Assistant",
  description: "Real-time dual-speaker transcription and context-aware answer assistance with a local Candidate Knowledge Pack and low-latency LLM streaming.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${inter.className} ${poppins.variable} bg-slate-900 text-slate-100 min-h-screen`}>
        {children}
        <Analytics />
      </body>
    </html>
  );
}
