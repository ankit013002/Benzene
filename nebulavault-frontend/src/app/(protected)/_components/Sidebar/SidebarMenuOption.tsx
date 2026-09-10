"use client";

import { SideBarOptionType } from "@/utils/SideBarOptions";
import Link from "next/link";
import React from "react";

interface SidebarMenuOptionProps {
  option: SideBarOptionType;
  isSelected: boolean;
}

export default function SideBarMenuOption({
  option,
  isSelected,
}: SidebarMenuOptionProps) {
  return (
    <Link
      href={option.href}
      aria-current={isSelected ? "page" : undefined}
      className={`join-item btn btn-ghost w-full justify-start gap-3 border-r-0 border-y-0  ${
        isSelected
          ? "bg-sidebar-accent text-sidebar-accent-foreground border-l-2 border-l-sidebar-primary"
          : "bg-transparent border-l-0"
      }`}
    >
      {option.icon && <span className="text-lg">{option.icon}</span>}
      <span>{option.name}</span>
    </Link>
  );
}
