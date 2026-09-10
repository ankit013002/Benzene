"use client";

import { SideBarOptions } from "@/utils/SideBarOptions";
import React from "react";
import { usePathname } from "next/navigation";
import SideBarMenuOption from "./SidebarMenuOption";

const SideBarMenuOptions = () => {
  const pathname = usePathname();

  return (
    <div className="flex flex-col w-full">
      {SideBarOptions.map((option) => {
        const isSelected =
          pathname === option.href || pathname.startsWith(`${option.href}/`);

        return <SideBarMenuOption key={option.id} option={option} isSelected={isSelected} />;
      })}
    </div>
  );
};

export default SideBarMenuOptions;
