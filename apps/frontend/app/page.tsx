import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { getDefaultAuthenticatedRoute } from "../client.config";

export default function HomePage() {
  const session = getSession();
  redirect(session ? getDefaultAuthenticatedRoute() : "/login");
}
