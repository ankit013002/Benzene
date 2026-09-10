import { redirect } from "next/navigation";
import StoreProvider from "@/app/store/StoreProvider";
import { getSession } from "@/utils/auth/handlers/LoginHandler";
import Sidebar from "./_components/Sidebar/Sidebar";
import { cookies } from "next/headers";
import ClientHydrator from "../(app)/ClientHydrator";

type Me = {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  plan: string;
  quotaBytes: number;
  usedBytes: number;
  createdAt?: string;
  updatedAt?: string;
} | null;

export default async function ProtectedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();
  if (!session) redirect("/login");
  let me: Me = null;
  // Bootstrap the profile only when the user service has no record yet.
  try {
    const cookieHeader = (await cookies()).toString();
    let res = null;

    res = await fetch(`${process.env.APP_BASE_URL}/api/dev-proxy/user/me`, {
      method: "GET",
      cache: "no-store",
      headers: {
        cookie: cookieHeader,
        "content-type": "application/json",
      },
    });
    if (res.status === 404) {
      res = await fetch(
        `${process.env.APP_BASE_URL}/api/dev-proxy/user/bootstrap`,
        {
          method: "POST",
          cache: "no-store",
          headers: {
            cookie: cookieHeader,
            "content-type": "application/json",
          },
        }
      );
    }
    me = res.ok ? await res.json() : null;

    if (!res.ok) console.error("Bootstrap failed:", res.status);
  } catch (err) {
    console.error("Bootstrap error:", err);
  }

  return (
    <StoreProvider>
      <ClientHydrator user={me} />
      <div className="flex">
        <div className="h-screen w-auto">
          <Sidebar />
        </div>
        <div className="w-full h-screen">{children}</div>
      </div>
    </StoreProvider>
  );
}
