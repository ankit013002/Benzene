import { ReactNode } from "react";
import {
  FaRegFolder,
  FaLaptop,
} from "react-icons/fa";

export type SideBarOptionType = {
  id: number;
  name: string;
  href: string;
  icon?: ReactNode;
};

export const SideBarOptions: SideBarOptionType[] = [
  {
    id: 0,
    name: "Vault",
    href: "/dashboard",
    icon: <FaRegFolder />,
  },
  {
    id: 1,
    name: "Devices",
    href: "/devices",
    icon: <FaLaptop />,
  },
];
