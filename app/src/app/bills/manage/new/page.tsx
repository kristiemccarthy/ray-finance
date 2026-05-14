import { addBill } from "@/app/actions";
import { BillForm, EMPTY_BILL_FORM_VALUES } from "@/components/bill-form";

export const dynamic = "force-dynamic";

export default function NewBillPage() {
  return (
    <main className="text-neutral-800">
      <div className="mx-auto max-w-2xl px-6 py-16">
        <h1 className="mb-12 text-center text-sm font-medium tracking-wide text-neutral-500 uppercase">
          Add Bill
        </h1>

        <BillForm
          action={addBill}
          initialValues={EMPTY_BILL_FORM_VALUES}
          submitLabel="Save"
        />
      </div>
    </main>
  );
}
