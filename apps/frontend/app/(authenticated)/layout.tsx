import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { getSession } from "@/lib/auth/session";
import { SkinAuthenticatedShell } from "@/skin";
import { clientConfig } from "../../client.config";

export default async function AuthenticatedLayout({
  children
}: Readonly<{
  children: ReactNode;
}>) {
  const session = getSession();

  if (!session) {
    redirect("/login");
  }

  return (
    <SkinAuthenticatedShell features={clientConfig.features} session={session}>
      {children}
    </SkinAuthenticatedShell>
  );
}
