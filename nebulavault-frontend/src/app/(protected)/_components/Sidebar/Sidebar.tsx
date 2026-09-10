import React from "react";
import SideBarTitleSection from "./SidebarTitleSection";
import SideBarMenuOptions from "./SidebarMenuOptions";
import SideBarAccountSection from "./SidebarAccountSection";

const Sidebar = () => {
  return (
    <div className="flex flex-col items-center gap-5 py-10 px-3 h-full border-r border-border bg-sidebar text-sidebar-foreground">
      <section className="w-full">
        <SideBarTitleSection />
      </section>
      <section className="w-full">
        <SideBarMenuOptions />
      </section>
      <section className="flex items-end w-full h-full">
        <SideBarAccountSection />
      </section>
    </div>
  );
};

export default Sidebar;
