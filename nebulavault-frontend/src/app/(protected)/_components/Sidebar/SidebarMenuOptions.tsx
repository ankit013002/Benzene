"use client";

import { SideBarOptions } from "@/utils/SideBarOptions";
import React, { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import SideBarMenuOption from "./SidebarMenuOption";

const SideBarMenuOptions = () => {
  const pathname = usePathname();
  const [pageSelected, setPageSelected] = useState("Dashboard");

  useEffect(() => {
    if (pathname) {
      const segments = pathname.split("/").filter(Boolean);
      const current = segments[0] || "dashboard";
      const formatted = current.charAt(0).toUpperCase() + current.slice(1);

      setPageSelected(formatted);
    }
  }, [pathname]);

  return (
    <div className="flex flex-col w-full">
      {SideBarOptions.map((option) => (
        <SideBarMenuOption
          key={option.id}
          option={option}
          pageSelected={pageSelected}
          setPageSelected={setPageSelected}
        />
      ))}
    </div>
  );
};

export default SideBarMenuOptions;
