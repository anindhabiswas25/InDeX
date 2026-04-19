import type { Metadata } from "next";
import "./globals.css";
import Navbar from "@/components/Navbar";
import SpaceBackground from "@/components/SpaceBackground";
import Providers from "./providers";

export const metadata: Metadata = {
  title: "InDex Protocol",
  description: "Liquid staking protocol on Initia — Stake INIT, receive INITx, unlock DeFi composability.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased dark">
      <body className="min-h-full flex flex-col bg-[#09090B]" style={{ fontFamily: "'Inter', system-ui, sans-serif" }}>
        <Providers>
          <SpaceBackground />
          <Navbar />
          <main className="flex-1 relative z-10">
            {children}
          </main>
        </Providers>
      </body>
    </html>
  );
}
