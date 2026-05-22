import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { RecategoriseButton } from "@/components/recategorise-button";
import { recategoriseEverything } from "../actions";

export const dynamic = "force-dynamic";

export default function SettingsPage() {
  return (
    <main className="text-neutral-800">
      <div className="mx-auto max-w-2xl px-6 py-16">
        <h1 className="mb-10 text-sm font-medium tracking-wide text-neutral-500 uppercase">
          Settings
        </h1>

        <nav className="overflow-hidden rounded-md border border-stone-200 bg-white">
          <SettingsLink
            href="/bills/manage"
            label="Manage bills"
            description="Add, edit, or delete recurring bills."
          />
          <SettingsLink
            href="/settings/categories"
            label="Manage categories"
            description="Rules that override automatic category detection."
          />
          <SettingsLink
            href="/settings/transactions"
            label="Transaction inspector"
            description="Browse, filter, and manually override individual transactions."
            isLast
          />
        </nav>

        <section className="mt-10">
          <h2 className="mb-2 text-xs font-medium tracking-wide text-neutral-500 uppercase">
            Maintenance
          </h2>
          <p className="mb-4 text-xs text-neutral-500">
            Re-run the categoriser over every transaction using the current
            rule set. Safe to run any time — only rows whose category would
            change are touched.
          </p>
          <RecategoriseButton action={recategoriseEverything} />
        </section>
      </div>
    </main>
  );
}

function SettingsLink({
  href,
  label,
  description,
  isLast = false,
}: {
  href: string;
  label: string;
  description: string;
  isLast?: boolean;
}) {
  return (
    <Link
      href={href}
      className={`flex items-center gap-4 px-5 py-4 hover:bg-stone-50 ${
        isLast ? "" : "border-b border-stone-100"
      }`}
    >
      <div className="flex-1">
        <div className="text-sm font-medium text-neutral-900">{label}</div>
        <div className="mt-0.5 text-xs text-neutral-500">{description}</div>
      </div>
      <ChevronRight
        className="h-4 w-4 shrink-0 text-neutral-400"
        strokeWidth={2}
      />
    </Link>
  );
}
