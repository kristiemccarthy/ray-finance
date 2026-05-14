import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Ray",
  description: "Local Ray finance dashboard",
  formatDetection: {
    telephone: false,
    date: false,
    address: false,
    email: false,
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-stone-50 text-neutral-800 antialiased">
        <nav className="border-b border-stone-200 bg-stone-50">
          <div className="mx-auto flex max-w-2xl items-center gap-6 px-6 py-4 text-sm">
            <Link
              href="/"
              className="font-medium text-neutral-700 hover:text-neutral-900"
            >
              Bills
            </Link>
            <Link
              href="/forecast"
              className="font-medium text-neutral-700 hover:text-neutral-900"
            >
              Forecast
            </Link>
            <Link
              href="/fortnight"
              className="font-medium text-neutral-700 hover:text-neutral-900"
            >
              This Fortnight
            </Link>
            <Link
              href="/balances"
              className="font-medium text-neutral-700 hover:text-neutral-900"
            >
              Balances
            </Link>
          </div>
        </nav>
        {children}
      </body>
    </html>
  );
}
