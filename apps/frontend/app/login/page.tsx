import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { SkinLoginPanel } from "@/skin";
import { getDefaultAuthenticatedRoute } from "../../client.config";

export default function LoginPage() {
  const session = getSession();

  if (session) {
    redirect(getDefaultAuthenticatedRoute());
  }

  return <SkinLoginPanel />;
}
