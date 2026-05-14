import { notFound } from "next/navigation";
import { getDb } from "@ray/db/connection";
import { updateBill, type BillFormState, type BillFormValues } from "@/app/actions";
import { BillForm } from "@/components/bill-form";

export const dynamic = "force-dynamic";

interface StoredBill {
  id: number;
  name: string;
  amount: number;
  day_of_month: number | null;
  frequency: string;
  next_due_date: string | null;
  type: string | null;
  account_id: string | null;
}

/** Trailing-range suffix produced by `formatBound` — e.g. " ($200-$280)" or " ($199.99-$249.50)". */
const RANGE_RE = /\s*\(\$(\d+(?:\.\d+)?)-\$(\d+(?:\.\d+)?)\)\s*$/;

/**
 * Split a stored bill's name into the base name and (if present) the encoded
 * range bounds. Mirrors the format that `addBill`/`updateBill` produces so
 * round-tripping an edit doesn't double-append the suffix.
 */
function unpackName(stored: string): { baseName: string; lo?: string; hi?: string } {
  const m = stored.match(RANGE_RE);
  if (!m) return { baseName: stored };
  return {
    baseName: stored.replace(RANGE_RE, "").trim(),
    lo: m[1],
    hi: m[2],
  };
}

function toInitialValues(bill: StoredBill): BillFormValues {
  const { baseName, lo, hi } = unpackName(bill.name);
  const isRange = lo !== undefined && hi !== undefined;
  return {
    name: baseName,
    amountType: isRange ? "range" : "fixed",
    amount: isRange ? "" : String(bill.amount),
    amountMin: lo ?? "",
    amountMax: hi ?? "",
    frequency: (bill.frequency === "fortnightly" || bill.frequency === "weekly"
      ? bill.frequency
      : "monthly"),
    dayOfMonth: bill.day_of_month?.toString() ?? "",
    nextDueDate: bill.next_due_date ?? "",
    type: bill.type ?? "",
    accountId: bill.account_id ?? "",
  };
}

export default async function EditBillPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: idParam } = await params;
  const id = Number.parseInt(idParam, 10);
  if (!Number.isInteger(id)) notFound();

  const db = getDb();
  const bill = db
    .prepare(
      `SELECT id, name, amount, day_of_month, frequency, next_due_date, type, account_id
         FROM recurring_bills WHERE id = ?`,
    )
    .get(id) as StoredBill | undefined;

  if (!bill) notFound();

  const action = async (
    state: BillFormState,
    formData: FormData,
  ): Promise<BillFormState> => {
    "use server";
    return updateBill(id, state, formData);
  };

  return (
    <main className="text-neutral-800">
      <div className="mx-auto max-w-2xl px-6 py-16">
        <h1 className="mb-12 text-center text-sm font-medium tracking-wide text-neutral-500 uppercase">
          Edit Bill
        </h1>

        <BillForm
          action={action}
          initialValues={toInitialValues(bill)}
          submitLabel="Save changes"
        />
      </div>
    </main>
  );
}
