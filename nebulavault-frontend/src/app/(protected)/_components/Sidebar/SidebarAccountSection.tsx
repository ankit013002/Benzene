"use client";

import Image from "next/image";
import React, { useEffect, useState } from "react";
import pfp from "/public/pfp.jpg";
import { logout } from "@/utils/auth/handlers/LogoutHandler";
import { useRouter } from "next/navigation";
import { useAppSelector } from "@/app/store/hooks";
import { getNormalizedSize } from "@/utils/file-system/NormalizedSize";
import LoadingSpinner from "@/components/LoadingSpinner";

type Props = {
  name?: string;
  email?: string;
  usedGb?: number;
  quotaGb?: number;
};

const SideBarAccountSection: React.FC<Props> = () => {
  const router = useRouter();
  const user = useAppSelector((state) => state.user);

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [usedGb, setUsedGb] = useState(0);
  const [quotaGb, setQuotaGb] = useState(0);
  const [pct, setPct] = useState(0);
  const [isloading, setIsLoading] = useState(true);

  useEffect(() => {
    if (user.id && user.id.length > 0) {
      setIsLoading(false);
    }
    setName(user.name ?? "");
    setEmail(user.email);
    setUsedGb(getNormalizedSize(user.usedBytes).value);
    setQuotaGb(getNormalizedSize(user.quotaBytes).value);
    setPct(
      user.quotaBytes > 0
        ? Math.min(100, Math.round((user.usedBytes / user.quotaBytes) * 100))
        : 0,
    );
  }, [user]);

  useEffect(() => {}, []);

  const onSignOut = async () => {
    const res = await logout();
    if (res) {
      router.replace("/");
      router.refresh();
    } else {
      // TODO: Handle accordingly
      console.log("Couldn't Sign Out");
    }
  };

  return (
    <>
      {isloading ? (
        <div className="mt-auto bottom-0 w-full justify-center">
          <LoadingSpinner />
        </div>
      ) : (
        <div className="mt-auto sticky bottom-0 inset-x-0 bg-sidebar/80 backdrop-blur-md border-t border-border shadow-card p-3">
          <>
            <div className="h-px w-full bg-border mb-3" />

            <div className="flex items-center gap-3">
              <div className="relative">
                <div className="bg-border p-px rounded-full shadow-glow-sm">
                  <div className="relative w-10 h-10 rounded-full overflow-hidden bg-sidebar">
                    <Image
                      src={pfp}
                      alt="Profile picture"
                      fill
                      sizes="40px"
                      className="object-cover"
                      priority
                    />
                  </div>
                </div>
                <span
                  className="
              absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full
              bg-success ring-2 ring-bz-surface
            "
                  aria-hidden
                />
              </div>

              <div className="min-w-0">
                <div className="font-medium leading-5 text-foreground truncate">
                  {name}
                </div>
                <div className="text-xs text-muted-foreground truncate">{email}</div>
              </div>

              <div className="ml-auto flex items-center gap-1">
                <button
                  className="btn btn-ghost btn-sm btn-square tooltip text-foreground hover:text-foreground/90"
                  data-tip="Upload"
                  aria-label="Upload"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                    <path
                      d="M12 16V4M12 4l-4 4M12 4l4 4"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                    <path
                      d="M4 20h16"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                    />
                  </svg>
                </button>

                <div className="dropdown dropdown-top dropdown-end">
                  <button
                    tabIndex={0}
                    className="btn btn-ghost btn-sm btn-square tooltip text-foreground hover:text-foreground/90"
                    data-tip="Account"
                    aria-label="Account menu"
                  >
                    <svg
                      width="18"
                      height="18"
                      viewBox="0 0 24 24"
                      fill="currentColor"
                    >
                      <circle cx="5" cy="12" r="1.7" />
                      <circle cx="12" cy="12" r="1.7" />
                      <circle cx="19" cy="12" r="1.7" />
                    </svg>
                  </button>
                  <ul
                    tabIndex={0}
                    className="
                dropdown-content menu menu-sm z-10 w-56 p-2
                rounded-box bg-bz-surface/95 backdrop-blur-xl shadow-card
                border border-bz-border
              "
                  >
                    <li className="menu-title px-2 text-muted-foreground">Account</li>
                    <li>
                      <a className="text-foreground">Profile</a>
                    </li>
                    <li>
                      <a className="text-foreground">Settings</a>
                    </li>
                    <li>
                      <a className="text-foreground">Keyboard shortcuts</a>
                    </li>
                    <li>
                      <button
                        className="text-error"
                        onClick={() => onSignOut()}
                      >
                        Sign out
                      </button>
                    </li>
                  </ul>
                </div>
              </div>
            </div>

            <div className="mt-3">
              <div className="mb-1 flex justify-between text-[11px] text-muted-foreground">
                <span>
                  {usedGb} / {quotaGb} GB
                </span>
                <span>{pct}%</span>
              </div>

              <div
                className="
            relative h-2 w-full overflow-hidden rounded-full
            bg-bz-surface/60 border border-bz-border
          "
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={pct}
              >
                <div className="absolute inset-0 bg-primary/10" />
                <div
                  className="
              relative h-full rounded-full shadow-glow-sm
              bg-primary
            "
                  style={{ width: `${pct}%` }}
                />
                <div
                  className="
                pointer-events-none absolute inset-0 rounded-full
                bg-primary-foreground/30
                animate-shimmer w-full
              "
                  style={{ transform: "translateX(-100%)" }}
                />
              </div>
            </div>
          </>
        </div>
      )}
    </>
  );
};

export default SideBarAccountSection;
