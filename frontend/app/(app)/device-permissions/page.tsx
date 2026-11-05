import { redirect } from "next/navigation";

export default function LegacyDevicePermissionsPage() {
  redirect("/dashboard?focus=child-selection");
}
