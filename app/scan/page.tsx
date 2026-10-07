import { redirect } from "next/navigation";

export default function ScanPage(): never {
  redirect("/coach?open=scan");
}
