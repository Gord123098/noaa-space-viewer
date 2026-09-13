import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "NOAA Orbital Desk — GOES & Space Weather Viewer",
  description: "Live NOAA GOES Earth imagery, solar observations, aurora forecasts, and space-weather telemetry.",
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body className="antialiased">{children}</body></html>;
}
